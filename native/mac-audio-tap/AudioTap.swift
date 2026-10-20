// copilot-audio-tap — records the Mac's system audio output (everything you
// hear) with a Core Audio process tap and writes it to stdout as 16 kHz mono
// 16-bit little-endian PCM, in 100 ms chunks. The Electron main process spawns
// it on Start (see src/main/mac-audio-tap.js) and forwards the chunks to the
// renderer, which transcribes them.
//
// Needs macOS 14.2+ and the "System Audio Recording" permission, which macOS
// asks for once, on behalf of the app that spawned this helper (the prompt uses
// the app's NSAudioCaptureUsageDescription). A denied permission does not fail:
// the tap simply delivers silence, which the app reports as "no sound".
//
// Status goes to stderr as one JSON object per line:
//   {"event":"ready","output":"MacBook Pro Speakers","sampleRate":48000,"channels":2}
//   {"event":"output","output":"AirPods Pro"}          default output changed
//   {"event":"error","message":"…","status":-50}       then exit(1)
// The helper exits when stdin closes (the app quit or crashed) or on SIGTERM.

import AVFoundation
import CoreAudio
import Foundation

let OUT_RATE = 16000.0
let CHUNK_SAMPLES = 1600

func emit(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
  FileHandle.standardError.write(data + Data("\n".utf8))
}

func fail(_ message: String, _ status: OSStatus = 0) -> Never {
  emit(["event": "error", "message": message, "status": Int(status)])
  exit(1)
}

func globalAddress(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

func defaultOutputDevice() -> AudioObjectID {
  var address = globalAddress(kAudioHardwarePropertyDefaultOutputDevice)
  var device = AudioObjectID(kAudioObjectUnknown)
  var size = UInt32(MemoryLayout<AudioObjectID>.size)
  AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device)
  return device
}

func stringProperty(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String {
  var address = globalAddress(selector)
  var value: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr, let v = value else { return "" }
  return v.takeRetainedValue() as String
}

@available(macOS 14.2, *)
final class SystemAudioTap {
  private var tapID = AudioObjectID(kAudioObjectUnknown)
  private var aggregateID = AudioObjectID(kAudioObjectUnknown)
  private var procID: AudioDeviceIOProcID?
  private let ioQueue = DispatchQueue(label: "copilot.audio-tap.io", qos: .userInteractive)
  private var converter: AVAudioConverter?
  private var inputFormat: AVAudioFormat?
  private let outputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: OUT_RATE, channels: 1, interleaved: true)!
  private var pending = [Int16]()

  func start() {
    // A private, unmuted stereo tap on every process: a copy of the system mix.
    let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
    description.name = "Interview Copilot system audio"
    description.isPrivate = true
    description.muteBehavior = .unmuted

    var status = AudioHardwareCreateProcessTap(description, &tapID)
    guard status == noErr else { fail("could not create the system audio tap", status) }

    var formatAddress = globalAddress(kAudioTapPropertyFormat)
    var asbd = AudioStreamBasicDescription()
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    status = AudioObjectGetPropertyData(tapID, &formatAddress, 0, nil, &size, &asbd)
    guard status == noErr, let format = AVAudioFormat(streamDescription: &asbd) else { fail("could not read the tap's audio format", status) }
    inputFormat = format
    converter = AVAudioConverter(from: format, to: outputFormat)
    guard converter != nil else { fail("no converter from \(format) to 16 kHz mono") }

    // The tap is read through a private aggregate device that contains only it,
    // so it keeps working when the output device changes (e.g. AirPods).
    let aggregate: [String: Any] = [
      kAudioAggregateDeviceNameKey: "Interview Copilot Tap",
      kAudioAggregateDeviceUIDKey: UUID().uuidString,
      kAudioAggregateDeviceIsPrivateKey: true,
      kAudioAggregateDeviceIsStackedKey: false,
      kAudioAggregateDeviceTapAutoStartKey: true,
      kAudioAggregateDeviceSubDeviceListKey: [] as [Any],
      kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: description.uuid.uuidString]]
    ]
    status = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID)
    guard status == noErr else { fail("could not create the capture device", status) }

    status = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, ioQueue) { [weak self] _, input, _, _, _ in
      self?.process(input)
    }
    guard status == noErr else { fail("could not attach to the capture device", status) }
    status = AudioDeviceStart(aggregateID, procID)
    guard status == noErr else { fail("could not start capturing", status) }

    emit(["event": "ready", "output": stringProperty(defaultOutputDevice(), kAudioObjectPropertyName),
          "sampleRate": format.sampleRate, "channels": Int(format.channelCount)])
    watchDefaultOutput()
  }

  private func process(_ input: UnsafePointer<AudioBufferList>) {
    guard let format = inputFormat, let converter,
          let buffer = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: input, deallocator: nil),
          buffer.frameLength > 0 else { return }

    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * OUT_RATE / format.sampleRate) + 32
    guard let out = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return }
    var consumed = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, inputStatus in
      if consumed { inputStatus.pointee = .noDataNow; return nil }
      consumed = true
      inputStatus.pointee = .haveData
      return buffer
    }
    guard error == nil, let samples = out.int16ChannelData?[0], out.frameLength > 0 else { return }

    pending.append(contentsOf: UnsafeBufferPointer(start: samples, count: Int(out.frameLength)))
    while pending.count >= CHUNK_SAMPLES {
      let chunk = pending.prefix(CHUNK_SAMPLES)
      FileHandle.standardOutput.write(chunk.withUnsafeBufferPointer { Data(buffer: $0) })
      pending.removeFirst(CHUNK_SAMPLES)
    }
  }

  private func watchDefaultOutput() {
    var address = globalAddress(kAudioHardwarePropertyDefaultOutputDevice)
    AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, DispatchQueue.main) { _, _ in
      emit(["event": "output", "output": stringProperty(defaultOutputDevice(), kAudioObjectPropertyName)])
    }
  }

  func stop() {
    if let procID {
      AudioDeviceStop(aggregateID, procID)
      AudioDeviceDestroyIOProcID(aggregateID, procID)
    }
    if aggregateID != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggregateID) }
    if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
  }
}

// Runs until stdin closes or a signal arrives.
@available(macOS 14.2, *)
func run() -> Never {
  let tap = SystemAudioTap()
  tap.start()

  func shutdown() -> Never {
    tap.stop()
    exit(0)
  }

  signal(SIGPIPE, SIG_IGN)
  let signalSources = [SIGTERM, SIGINT].map { sig -> DispatchSourceSignal in
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler { shutdown() }
    source.resume()
    return source
  }

  // The parent holds our stdin open; EOF means it is gone, so do not linger.
  DispatchQueue.global(qos: .utility).async {
    while !FileHandle.standardInput.availableData.isEmpty {}
    DispatchQueue.main.async { shutdown() }
  }

  withExtendedLifetime(signalSources) { dispatchMain() }
}

if #available(macOS 14.2, *) {
  run()
} else {
  emit(["event": "error", "message": "system audio capture needs macOS 14.2 or later", "status": 0, "unsupported": true])
  exit(2)
}
