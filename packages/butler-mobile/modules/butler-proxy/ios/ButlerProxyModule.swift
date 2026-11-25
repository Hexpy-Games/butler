import ExpoModulesCore
import Foundation
import Network

public final class ButlerProxyModule: Module {
  private let queue = DispatchQueue(label: "games.hexpy.butler.proxy")
  private var starting: [ObjectIdentifier: NWListener] = [:]
  private var listeners: [Int: NWListener] = [:]
  private var accepted: [ObjectIdentifier: (port: Int, connection: NWConnection)] = [:]
  private var connections: [Int: (port: Int, connection: NWConnection)] = [:]
  private var nextId = 1

  public func definition() -> ModuleDefinition {
    Name("ButlerProxy")
    Events("onRequest", "onCancel")

    AsyncFunction("start") { (promise: Promise) in
      self.start(promise)
    }.runOnQueue(queue)

    Function("stop") { (port: Int) in
      self.queue.async { self.stop(port) }
    }

    Function("respondHead") { (id: Int, status: Int, headers: [String: String]) in
      self.queue.async {
        guard let connection = self.connections[id]?.connection else { return }
        var head = "HTTP/1.1 \(status) \r\n"
        for (name, value) in headers where !name.utf8.contains(13) && !name.utf8.contains(10) && !value.utf8.contains(13) && !value.utf8.contains(10) {
          head += "\(name): \(value)\r\n"
        }
        head += "connection: close\r\n\r\n"
        connection.send(content: Data(head.utf8), completion: .contentProcessed { error in
          if error != nil { self.cancelled(id) }
        })
      }
    }

    // Expo copies a JS Uint8Array into Data on the JS thread before dispatching.
    AsyncFunction("respondChunk") { (id: Int, data: Data, promise: Promise) in
      guard let connection = self.connections[id]?.connection else {
        promise.reject("ERR_PROXY_CLOSED", "Connection closed")
        return
      }
      connection.send(content: data, completion: .contentProcessed { error in
        if error != nil {
          self.cancelled(id)
          promise.reject("ERR_PROXY_CLOSED", "Connection closed")
        } else {
          promise.resolve()
        }
      })
    }.runOnQueue(queue)

    Function("respondEnd") { (id: Int) in
      self.queue.async {
        guard let connection = self.connections.removeValue(forKey: id)?.connection else { return }
        connection.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in
          self.close(connection)
        })
      }
    }

    Function("respondAbort") { (id: Int) in
      self.queue.async {
        if let connection = self.connections.removeValue(forKey: id)?.connection { self.close(connection) }
      }
    }

    OnDestroy {
      self.queue.async {
        for listener in self.starting.values { listener.cancel() }
        for port in Array(self.listeners.keys) { self.stop(port) }
      }
    }
  }

  private func start(_ promise: Promise) {
    do {
      let params = NWParameters.tcp
      params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
      let listener = try NWListener(using: params)
      let key = ObjectIdentifier(listener)
      starting[key] = listener
      listener.stateUpdateHandler = { [weak self, weak listener] state in
        guard let self, let listener else { return }
        switch state {
        case .ready:
          let port = Int(listener.port!.rawValue)
          self.starting.removeValue(forKey: key)
          self.listeners[port] = listener
          listener.stateUpdateHandler = nil
          promise.resolve(port)
        case .failed, .cancelled:
          self.starting.removeValue(forKey: key)
          listener.stateUpdateHandler = nil
          listener.cancel()
          promise.reject("ERR_PROXY_START", "Could not start listener")
        default: break
        }
      }
      listener.newConnectionHandler = { [weak self, weak listener] connection in
        guard let self, let port = listener?.port, self.listeners[Int(port.rawValue)] != nil else {
          connection.cancel()
          return
        }
        let number = Int(port.rawValue)
        self.accepted[ObjectIdentifier(connection)] = (number, connection)
        connection.start(queue: self.queue)
        self.readHead(connection, port: number, data: Data())
      }
      listener.start(queue: queue)
    } catch {
      promise.reject("ERR_PROXY_START", "Could not start listener")
    }
  }

  private func readHead(_ connection: NWConnection, port: Int, data: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { bytes, _, complete, error in
      guard self.accepted[ObjectIdentifier(connection)] != nil else { return }
      var head = data
      if let bytes { head.append(bytes) }
      if let end = head.range(of: Data("\r\n\r\n".utf8)) {
        guard end.upperBound <= 16_384 else { self.close(connection); return }
        self.request(connection, port: port, head: String(decoding: head[..<end.lowerBound], as: UTF8.self))
      } else if head.count >= 16_384 || complete || error != nil {
        self.close(connection)
      } else {
        self.readHead(connection, port: port, data: head)
      }
    }
  }

  private func request(_ connection: NWConnection, port: Int, head: String) {
    let lines = head.components(separatedBy: "\r\n")
    let request = lines[0].components(separatedBy: " ")
    guard request.count == 3, request[1].hasPrefix("/") else { close(connection); return }
    var headers: [String: String] = [:]
    for line in lines.dropFirst() {
      guard let colon = line.firstIndex(of: ":") else { continue }
      let name = line[..<colon].lowercased()
      let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
      headers[name] = headers[name].map { $0 + (name == "cookie" ? "; " : ", ") + value } ?? value
    }
    let id = nextId
    nextId += 1
    connections[id] = (port, connection)
    connection.stateUpdateHandler = { [weak self] state in
      switch state {
      case .failed, .cancelled: self?.cancelled(id)
      default: break
      }
    }
    sendEvent("onRequest", ["id": id, "port": port, "method": request[0], "target": request[1], "headers": headers])
  }

  private func cancelled(_ id: Int) {
    if let connection = connections.removeValue(forKey: id)?.connection {
      close(connection)
      sendEvent("onCancel", ["id": id])
    }
  }

  private func close(_ connection: NWConnection) {
    accepted.removeValue(forKey: ObjectIdentifier(connection))
    connection.cancel()
  }

  private func stop(_ port: Int) {
    listeners.removeValue(forKey: port)?.cancel()
    for (id, entry) in connections where entry.port == port { connections.removeValue(forKey: id) }
    for entry in accepted.values where entry.port == port { close(entry.connection) }
  }
}
