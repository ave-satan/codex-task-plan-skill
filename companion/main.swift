import AppKit
import SwiftUI
import Darwin

struct Worker: Codable {
    var name: String
    var category: String?
    var status: String?
}
struct Step: Codable, Identifiable {
    var id: String
    var title: String
    var status: String
    var progress: Double?
    var note: String?
    var worker: String?
    var agents: [Worker]?
}
struct Plan: Codable, Identifiable {
    var id: String
    var title: String
    var revision: Int
    var steps: [Step]
    var status: String?
    var completedAt: String?
    var source: String?
    var sourceRevision: Int?
    var creationSequence: Int?
    var done: Int { steps.filter { ["completed", "skipped"].contains($0.status) }.count }
}

private let planEmojiPool = [
    "🫠","🫨","🥴","🤪","🫥","🫣","🥸","👹","👺","👻",
    "👽","👾","🤖","💩","😈","👿","☠️","💀","🤯","🤤",
    "🤓","🧐","🥶","🥵","🤢","🤮","🤧","🤬","😵‍💫","😵",
    "😶‍🌫️","😬","🙃","🤐","🫤",
    "🐙","🦑","🪼","🦀","🦞","🦐","🐡","🦈","🐊","🦎",
    "🐍","🐲","🐉","🦖","🦕","🦧","🦍","🦥","🦦","🦨",
    "🦡","🦔","🐀","🐿️","🦇","🦉","🦤","🦚","🦩","🪿",
    "🐓","🦃","🦆","🐸","🐌","🪲","🪳","🕷️","🦂","🦗",
    "🐛","🐝","🪰","🦟","🪱","🐗","🐐","🦙","🦒","🦛",
    "🦘","🦣","🦬","🐫","🦏","🦫","🦭","🦠","🪸","🐚",
    "🍄","🌵","🪴","🧌","🗿","🧠","🫀","🫁","🦷","🦴",
    "👁️","👀","👅","🫦","🦾","🦿","🧿","🔮","🪤","🧪",
    "🧫","🧬","🩻","🛸","🛰️","🚽","🪠","🧻","🛒","🧹",
    "🪣","🪆","⚰️","🪦","🧲",
    "🍆","🍑","🌽","🥒","🫑","🧄","🧅","🥦","🥬","🥥",
    "🥝","🥨","🧀","🧇","🥓","🍤","🦪","🍥","🧋","🫙"
]

private func stablePlanHash(_ value: String) -> UInt64 {
    value.utf8.reduce(UInt64(1469598103934665603)) { ($0 ^ UInt64($1)) &* 1099511628211 }
}

private func planEmoji(_ plan: Plan) -> String {
    planEmojiPool[Int(stablePlanHash(plan.id) % UInt64(planEmojiPool.count))]
}

private enum CodexPalette {
    static let surface = Color(red: 34 / 255, green: 34 / 255, blue: 36 / 255)
    static let stepsSurface = Color(red: 31 / 255, green: 31 / 255, blue: 33 / 255)
    static let raised = Color(red: 55 / 255, green: 55 / 255, blue: 58 / 255)
    static let primary = Color(red: 216 / 255, green: 217 / 255, blue: 220 / 255)
    static let stepPrimary = Color(red: 184 / 255, green: 184 / 255, blue: 186 / 255)
    static let secondary = Color(red: 142 / 255, green: 143 / 255, blue: 147 / 255)
    static let muted = Color(red: 82 / 255, green: 83 / 255, blue: 88 / 255)
    static let border = Color(red: 48 / 255, green: 48 / 255, blue: 50 / 255)
    static let blue = Color(red: 114 / 255, green: 134 / 255, blue: 193 / 255)
    static let green = Color(red: 91 / 255, green: 157 / 255, blue: 112 / 255)
    static let red = Color(red: 199 / 255, green: 108 / 255, blue: 108 / 255)
    static let orange = Color(red: 181 / 255, green: 143 / 255, blue: 91 / 255)
    static let statusBlue = Color(red: 10 / 255, green: 132 / 255, blue: 255 / 255)
    static let statusGreen = Color(red: 48 / 255, green: 209 / 255, blue: 88 / 255)
    static let statusRed = Color(red: 255 / 255, green: 69 / 255, blue: 58 / 255)
    static let statusOrange = Color(red: 255 / 255, green: 159 / 255, blue: 10 / 255)
}

private enum PanelMetrics {
    static let inset: CGFloat = 12
    static let iconColumn: CGFloat = 24
    static let planIconGlyph: CGFloat = 18
    static let minimumWidth: CGFloat = 280
    static let minimumHeight: CGFloat = 240
    static let columnGap: CGFloat = 8
    static let headerBottom: CGFloat = 8
    static let headerDivider: CGFloat = 0.5
    static let planHoverExitGrace: TimeInterval = 0.18
}

private let completionCheckDuration: TimeInterval = 1.35

private func parseISODate(_ value: String?) -> Date? {
    guard let value else { return nil }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
}

private func normalizedTerminalPlan(_ original: Plan, now: Date = Date()) -> Plan {
    var plan = original
    if ["completed", "cancelled"].contains(plan.status ?? ""), parseISODate(plan.completedAt) == nil {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        plan.completedAt = formatter.string(from: now)
    }
    return plan
}
struct WindowFrame: Codable {
    var x: Double
    var y: Double
    var width: Double
    var height: Double
}

final class SpaceWindowRouter {
    typealias MainConnectionFn = @convention(c) () -> UInt32
    typealias CopyManagedSpacesFn = @convention(c) (UInt32) -> Unmanaged<CFArray>?
    typealias ActiveSpaceFn = @convention(c) (UInt32) -> UInt64
    typealias CopyWindowSpacesFn = @convention(c) (UInt32, Int32, CFArray) -> Unmanaged<CFArray>?
    typealias MutateWindowSpacesFn = @convention(c) (UInt32, CFArray, CFArray) -> Int32
    typealias MoveWindowsToSpaceFn = @convention(c) (UInt32, CFArray, UInt64) -> Int32

    private let handle: UnsafeMutableRawPointer
    private let connection: UInt32
    private let copyManagedSpaces: CopyManagedSpacesFn
    private let activeSpaceFunction: ActiveSpaceFn
    private let copyWindowSpaces: CopyWindowSpacesFn
    private let addWindowsToSpaces: MutateWindowSpacesFn
    private let removeWindowsFromSpaces: MutateWindowSpacesFn
    private let moveWindowsToSpace: MoveWindowsToSpaceFn

    init?() {
        let path = "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight"
        guard let handle = dlopen(path, RTLD_NOW),
              let mainSymbol = dlsym(handle, "CGSMainConnectionID"),
              let managedSymbol = dlsym(handle, "CGSCopyManagedDisplaySpaces"),
              let activeSymbol = dlsym(handle, "CGSGetActiveSpace"),
              let copySymbol = dlsym(handle, "CGSCopySpacesForWindows"),
              let addSymbol = dlsym(handle, "CGSAddWindowsToSpaces"),
              let removeSymbol = dlsym(handle, "CGSRemoveWindowsFromSpaces"),
              let moveSymbol = dlsym(handle, "CGSMoveWindowsToManagedSpace") else {
            return nil
        }
        self.handle = handle
        let main = unsafeBitCast(mainSymbol, to: MainConnectionFn.self)
        connection = main()
        guard connection != 0 else { dlclose(handle); return nil }
        copyManagedSpaces = unsafeBitCast(managedSymbol, to: CopyManagedSpacesFn.self)
        activeSpaceFunction = unsafeBitCast(activeSymbol, to: ActiveSpaceFn.self)
        copyWindowSpaces = unsafeBitCast(copySymbol, to: CopyWindowSpacesFn.self)
        addWindowsToSpaces = unsafeBitCast(addSymbol, to: MutateWindowSpacesFn.self)
        removeWindowsFromSpaces = unsafeBitCast(removeSymbol, to: MutateWindowSpacesFn.self)
        moveWindowsToSpace = unsafeBitCast(moveSymbol, to: MoveWindowsToSpaceFn.self)
    }

    deinit { dlclose(handle) }

    func activeSpace() -> UInt64? {
        let value = activeSpaceFunction(connection)
        return value == 0 ? nil : value
    }

    func spaces(for windowNumber: Int) -> [UInt64] {
        let windows = [NSNumber(value: windowNumber)] as CFArray
        guard let result = copyWindowSpaces(connection, 7, windows)?.takeRetainedValue() else { return [] }
        return (result as NSArray).compactMap { ($0 as? NSNumber)?.uint64Value }
    }

    func displaySpaces(containing space: UInt64) -> [UInt64] {
        guard let managed = copyManagedSpaces(connection)?.takeRetainedValue() else { return [] }
        for case let display as NSDictionary in managed as NSArray {
            guard let rawSpaces = display["Spaces"] as? NSArray else { continue }
            let ids = rawSpaces.compactMap { item -> UInt64? in
                guard let dictionary = item as? NSDictionary else { return nil }
                return (dictionary["id64"] as? NSNumber)?.uint64Value
                    ?? (dictionary["ManagedSpaceID"] as? NSNumber)?.uint64Value
            }
            if ids.contains(space) { return ids }
        }
        return []
    }

    @discardableResult func assign(windowNumber: Int, to targetSpaces: [UInt64]) -> Bool {
        guard windowNumber > 0, !targetSpaces.isEmpty else { return false }
        let windows = [NSNumber(value: windowNumber)] as CFArray
        let orderedTarget = Array(NSOrderedSet(array: targetSpaces.map(NSNumber.init(value:))))
            .compactMap { ($0 as? NSNumber)?.uint64Value }
        guard let primarySpace = orderedTarget.first,
              moveWindowsToSpace(connection, windows, primarySpace) == 0 else {
            return false
        }
        if orderedTarget.count > 1 {
            let additional = orderedTarget.dropFirst().map(NSNumber.init(value:)) as CFArray
            guard addWindowsToSpaces(connection, windows, additional) == 0 else { return false }
        }
        let targetSet = Set(orderedTarget)
        let unexpected = spaces(for: windowNumber).filter { !targetSet.contains($0) }
        if !unexpected.isEmpty {
            let staleSpaces = unexpected.map(NSNumber.init(value:)) as CFArray
            guard removeWindowsFromSpaces(connection, windows, staleSpaces) == 0 else { return false }
        }
        return Set(spaces(for: windowNumber)) == targetSet
    }

    @discardableResult func assignVisibleWindow(windowNumber: Int, from hostSpace: UInt64,
                                                to targetSpaces: [UInt64]) -> Bool {
        guard windowNumber > 0, !targetSpaces.isEmpty else { return false }
        let windows = [NSNumber(value: windowNumber)] as CFArray
        let targetSet = Set(targetSpaces)
        let target = targetSpaces.map(NSNumber.init(value:)) as CFArray
        guard addWindowsToSpaces(connection, windows, target) == 0 else { return false }
        var staleSet = Set(spaces(for: windowNumber)).subtracting(targetSet)
        staleSet.insert(hostSpace)
        if !staleSet.isEmpty {
            let stale = staleSet.map(NSNumber.init(value:)) as CFArray
            guard removeWindowsFromSpaces(connection, windows, stale) == 0 else { return false }
        }
        return Set(spaces(for: windowNumber)) == targetSet
    }
}

struct Saved: Codable {
    var plans: [Plan]
    var selected: String?
    var creationWatermarks: [String: Int]?
    var windowFrame: WindowFrame? = nil
    var expandedWindowFrame: WindowFrame? = nil
    var unfocusedExpandedWindowFrame: WindowFrame? = nil
    var collapsedWindowFrame: WindowFrame? = nil
    var collapseWhenUnfocused: Bool? = nil
    var retentionStartedAt: [String: String]? = nil
}
struct Command: Decodable {
    var action: String
    var plan: Plan?
    var id: String?
    var name: String?
    var selectOnCreate: Bool?
    var x: Double?
    var y: Double?
    var width: Double?
    var height: Double?
    var enabled: Bool?
}
struct HostWindowObservation {
    var id: Int
    var frame: NSRect
}
struct PresentationTween {
    var token: Int
    var fromFrame: NSRect
    var toFrame: NSRect
    var fromAlpha: CGFloat
    var toAlpha: CGFloat
    var startedAt: TimeInterval
    var duration: TimeInterval
    var completion: (() -> Void)?
}

// All state transitions run on the AppKit main queue, including IPC updates.
final class Store: ObservableObject {
    @Published var plans: [Plan] = []
    @Published var selected: String?
    @Published var eventCount = 0
    @Published var planSwitcherExpanded = false
    @Published var hoveredPlanID: String?
    @Published var collapsed = false
    @Published var transitionIconOnly = false
    @Published var transitionToCollapsed = false
    @Published var collapsedHovered = false
    @Published var retentionDeadlines: [String: Date] = [:]
    @Published var retentionDuration: TimeInterval = 30
    var creationWatermarks: [String: Int] = [:]
    var changed: (() -> Void)?
    var removeRequested: ((String) -> Void)?
    var active: Plan? { plans.first { $0.id == selected } }
    func select(_ id: String) {
        guard plans.contains(where: { $0.id == id }) else { return }
        selected = id
        hoveredPlanID = nil
        planSwitcherExpanded = false
        changed?()
    }
    func upsert(_ plan: Plan, event: Bool = false, selectOnCreate: Bool = true) throws {
        let plan = normalizedTerminalPlan(plan)
        guard !plan.id.isEmpty, plan.id.count <= 120, !plan.title.isEmpty, plan.title.count <= 240,
              plan.revision > 0, (1...12).contains(plan.steps.count),
              Set(plan.steps.map(\.id)).count == plan.steps.count,
              plan.steps.allSatisfy({ !$0.id.isEmpty && !$0.title.isEmpty && $0.title.count <= 300 &&
                ["pending","in_progress","waiting_for_user","completed","blocked","skipped","paused"].contains($0.status) &&
                ($0.progress == nil || (0...100).contains($0.progress!)) }) else {
            throw NSError(domain: "Invalid plan", code: 1)
        }
        if let index = plans.firstIndex(where: { $0.id == plan.id }) {
            let becameCompleted = plans[index].status != "completed" && plan.status == "completed"
            if event && plan.revision <= plans[index].revision { return } // Durable replay ACK.
            guard plan.revision > plans[index].revision else { throw NSError(domain: "Stale revision", code: 2) }
            plans[index] = plan
            if becameCompleted { selected = plan.id }
        } else {
            plans.append(plan)
            if plan.status == "completed" { selected = plan.id }
            else if !event { selected = plan.id }
            else if selectOnCreate, let source = plan.source, let sequence = plan.creationSequence,
                    sequence > creationWatermarks[source, default: 0] {
                selected = plan.id; creationWatermarks[source] = sequence
            } else if selected == nil { selected = plan.id }
        }
        eventCount += 1; changed?()
    }
}

struct PendingDots: View {
    var animationKey: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var seed: UInt64 { stablePlanHash("pending|" + animationKey) }
    private var period: Double { 3.0 + Double(seed % 2400) / 1000 }
    private var phaseLead: Double { Double((seed >> 12) % 5000) / 1000 }

    private func lift(index: Int, at date: Date) -> Double {
        let elapsed = date.timeIntervalSinceReferenceDate + phaseLead
        let cycle = elapsed.truncatingRemainder(dividingBy: period)
        let local = cycle - Double(index) * 0.11
        guard local >= 0, local <= 0.48 else { return 0 }
        return -2.2 * sin(local / 0.48 * .pi)
    }

    @ViewBuilder private func dots(at date: Date?) -> some View {
        HStack(spacing: 1.8) {
            ForEach(0..<3, id: \.self) { index in
                let y = date.map { lift(index: index, at: $0) } ?? 0
                Circle()
                    .fill(CodexPalette.muted)
                    .frame(width: 2.4, height: 2.4)
                    .offset(y: y)
                    .opacity(y == 0 ? 0.50 : 0.72)
            }
        }
    }

    var body: some View {
        if reduceMotion {
            dots(at: nil)
        } else {
            TimelineView(.animation(minimumInterval: 1.0 / 24)) { context in
                dots(at: context.date)
            }
        }
    }
}

struct StatusIcon: View {
    var status: String
    var animationKey: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var symbol: String {
        switch status {
        case "completed": return "checkmark"
        case "in_progress": return "gearshape"
        case "waiting_for_user": return "questionmark.bubble"
        case "blocked": return "exclamationmark.circle"
        case "paused": return "pause.circle"
        case "skipped": return "minus"
        case "pending": return "minus"
        default: return "minus"
        }
    }
    var tint: Color {
        switch status {
        case "completed": return CodexPalette.statusGreen
        case "in_progress": return CodexPalette.statusBlue
        case "waiting_for_user": return CodexPalette.statusOrange
        case "blocked": return CodexPalette.statusRed
        case "paused", "skipped": return CodexPalette.statusOrange
        default: return CodexPalette.muted
        }
    }
    var body: some View {
        Group {
            if status == "pending" {
                PendingDots(animationKey: animationKey)
            } else if status == "in_progress" && !reduceMotion {
                TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
                    Image(systemName: symbol).font(.system(size: 13, weight: .medium))
                        .foregroundStyle(tint)
                        .rotationEffect(.degrees(context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 6) * 60))
                }
            } else if status == "waiting_for_user" && !reduceMotion {
                TimelineView(.animation(minimumInterval: 1.0 / 24)) { context in
                    let wave = (sin(context.date.timeIntervalSinceReferenceDate * .pi / 1.4) + 1) / 2
                    Image(systemName: symbol)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(tint)
                        .scaleEffect(1 + wave * 0.035)
                        .offset(y: -wave * 0.7)
                        .opacity(0.82 + wave * 0.18)
                }
            } else {
                Image(systemName: symbol).font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(tint)
            }
        }
        .frame(width: 24, height: 24)
        .offset(y: status == "pending" ? 0 : -4)
        .opacity(status == "pending" ? 0.82 : 1)
    }
}

private let agentArtwork: [String: NSImage] = {
    let categories = ["research", "architecture", "design", "implementation", "diagnostics",
                      "testing", "review", "documentation", "data", "operations"]
    guard let root = Bundle.main.resourceURL?.appendingPathComponent("agent-icons") else { return [:] }
    return Dictionary(uniqueKeysWithValues: categories.compactMap { category in
        guard let image = NSImage(contentsOf: root.appendingPathComponent("\(category).png")) else { return nil }
        return (category, image)
    })
}()

struct CompletionCheck: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let animationStart = Date()

    private func eased(_ value: Double) -> Double {
        let t = min(1, max(0, value))
        return t * t * (3 - 2 * t)
    }

    private func scale(at elapsed: Double) -> Double {
        let phase = min(1, max(0, elapsed / 0.44))
        if phase < 0.36 { return 0.55 + (1.18 - 0.55) * eased(phase / 0.36) }
        if phase < 0.68 { return 1.18 + (0.94 - 1.18) * eased((phase - 0.36) / 0.32) }
        return 0.94 + (1 - 0.94) * eased((phase - 0.68) / 0.32)
    }

    private func check(scale: Double, opacity: Double, angle: Double = 0, lift: Double = 0) -> some View {
        Image(systemName: "checkmark")
            .font(.system(size: 7, weight: .black))
            .foregroundStyle(CodexPalette.green)
            .shadow(color: .black.opacity(0.7), radius: 0.8)
            .scaleEffect(scale)
            .rotationEffect(.degrees(angle), anchor: .center)
            .opacity(opacity)
            .offset(x: 1.5, y: 1 + lift)
    }

    var body: some View {
        if reduceMotion {
            check(scale: 1, opacity: 1)
        } else {
            TimelineView(.animation(minimumInterval: 1.0 / 20)) { context in
                let elapsed = max(0, context.date.timeIntervalSince(animationStart))
                let settled = max(0, elapsed - 0.65)
                let turnPhase = settled.truncatingRemainder(dividingBy: 3.0) / 3.0
                let angle: Double = {
                    if turnPhase < 0.68 { return 0 }
                    if turnPhase < 0.76 { return -11 * eased((turnPhase - 0.68) / 0.08) }
                    if turnPhase < 0.84 { return -11 + 20 * eased((turnPhase - 0.76) / 0.08) }
                    if turnPhase < 0.92 { return 9 - 9 * eased((turnPhase - 0.84) / 0.08) }
                    return 0
                }()
                let activeTurn = turnPhase >= 0.68 && turnPhase < 0.92
                let emphasis = activeTurn ? sin((turnPhase - 0.68) / 0.24 * .pi) : 0
                check(scale: scale(at: elapsed) * (1 + 0.10 * emphasis),
                      opacity: min(1, elapsed / 0.10), angle: angle, lift: -0.7 * emphasis)
            }
        }
    }
}

struct AgentIcon: View {
    var agent: Worker
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let animationStart = Date()
    private var completed: Bool { agent.status == "completed" }
    private var category: String { agent.category ?? "" }

    private var seed: UInt32 {
        agent.name.unicodeScalars.reduce(UInt32(0)) { ($0 &* 31) &+ UInt32($1.value) }
    }

    private func sample(_ frames: [(Double, Double)], _ phase: Double) -> Double {
        guard let last = frames.last else { return 0 }
        for index in 1..<frames.count where phase <= frames[index].0 {
            let left = frames[index - 1], right = frames[index]
            let span = max(0.0001, right.0 - left.0)
            let linear = min(1, max(0, (phase - left.0) / span))
            let eased = linear * linear * (3 - 2 * linear)
            return left.1 + (right.1 - left.1) * eased
        }
        return last.1
    }

    private func motion(_ phase: Double) -> (angle: Double, x: Double, y: Double) {
        let zero = [(0.0, 0.0), (1.0, 0.0)]
        var angle = zero, x = zero, y = zero
        switch category {
        case "research": angle = [(0,0),(0.07692,-3),(0.15385,3),(0.23077,-3),(0.29231,3),(0.33846,0),(1,0)]
        case "architecture": angle = [(0,0),(0.12308,-2),(0.24615,2),(0.36923,0),(1,0)]
        case "design": angle = [(0,0),(0.23077,-4),(0.46154,0),(1,0)]
        case "implementation": y = [(0,0),(0.07692,-1),(0.15385,0),(0.23077,-1),(0.30769,0),(1,0)]
        case "diagnostics": x = [(0,0),(0.12308,1),(0.24615,-1),(0.36923,0),(1,0)]
        case "testing": angle = [(0,0),(0.12308,4),(0.27692,0),(1,0)]
        case "review": angle = [(0,0),(0.18462,-3),(0.43077,3),(0.61538,0),(1,0)]
        case "documentation":
            x = [(0,0),(0.12308,1),(0.30769,0),(1,0)]
            angle = [(0,0),(0.12308,5),(0.30769,0),(1,0)]
        case "data": y = [(0,0),(0.09231,1),(0.18462,-0.5),(0.27692,0.5),(0.36923,0),(1,0)]
        case "operations":
            x = [(0,0),(0.06154,-1),(0.12308,1),(0.18462,-0.5),(0.27692,0),(1,0)]
            angle = [(0,0),(0.06154,-2),(0.12308,2),(0.27692,0),(1,0)]
        default: break
        }
        return (sample(angle, phase), sample(x, phase), sample(y, phase))
    }

    @ViewBuilder private func artwork(opacity: Double, contrast: Double = 1,
                                      angle: Double = 0, x: Double = 0, y: Double = 0) -> some View {
        Group {
            if let image = agentArtwork[category] {
                Image(nsImage: image).resizable().interpolation(.high)
            } else {
                Image(systemName: "person.crop.circle").resizable().foregroundStyle(CodexPalette.blue)
            }
        }
        .aspectRatio(contentMode: .fit)
        .frame(width: 24, height: 24)
        .opacity(opacity)
        .contrast(contrast)
        .rotationEffect(.degrees(angle), anchor: UnitPoint(x: 0.5, y: 0.65))
        .offset(x: x, y: y)
        .overlay(alignment: .bottomTrailing) {
            if completed {
                CompletionCheck()
            }
        }
    }

    var body: some View {
        Group {
            if !completed && !reduceMotion {
                TimelineView(.animation(minimumInterval: 1.0 / 20)) { context in
                    let period = ((5 + Double(seed % 3001) / 1000) / 1.5) * 0.65
                    let phaseLead = Double(seed % 5000) / 1000
                    let elapsed = max(0, context.date.timeIntervalSince(animationStart)) + phaseLead
                    let phase = elapsed.truncatingRemainder(dividingBy: period) / period
                    let breathe = elapsed.truncatingRemainder(dividingBy: 2.5) / 2.5
                    let pulse = (1 + cos(breathe * 2 * .pi)) / 2
                    let transform = motion(phase)
                    artwork(opacity: 0.92 + 0.06 * pulse,
                            contrast: 0.95 + 0.08 * pulse,
                            angle: transform.angle, x: transform.x, y: transform.y)
                }
            } else {
                artwork(opacity: 1)
            }
        }
        .frame(width: 24, height: 24)
        .help("\(agent.category ?? "Агент") · \(agent.name) · \(completed ? "завершил" : "работает")")
    }
}

struct ThinProgressBar: View {
    var value: Double
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let animationStart = Date()
    private let blue = CodexPalette.blue
    private var fraction: Double { min(1, max(0, value / 100)) }

    var body: some View {
        GeometryReader { track in
            let fillWidth = track.size.width * fraction
            ZStack(alignment: .leading) {
                Capsule().fill(blue.opacity(0.15))
                Capsule()
                    .fill(blue)
                    .frame(width: fillWidth)
                    .overlay(alignment: .leading) {
                        if !reduceMotion, fillWidth > 0 {
                            TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
                                let elapsed = max(0, context.date.timeIntervalSince(animationStart))
                                let cycle = elapsed.truncatingRemainder(dividingBy: 2.4) / 2.4
                                LinearGradient(colors: [.clear, .white.opacity(0.72), .clear],
                                               startPoint: .leading, endPoint: .trailing)
                                    .frame(width: 22)
                                    .offset(x: -11 + (fillWidth + 11) * cycle)
                            }
                        }
                    }
                    .clipShape(Capsule())
                    .animation(reduceMotion ? nil : .timingCurve(0.22, 0.8, 0.3, 1, duration: 0.38), value: fraction)
            }
        }
        .frame(height: 3)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Прогресс шага")
        .accessibilityValue("\(Int(value.rounded())) процентов")
    }
}

struct StepHeadLayout: Layout {
    private struct Metrics {
        var title: CGSize
        var progress: CGSize
        var agents: [CGSize]
        var agentStride: CGFloat
        var agentsWidth: CGFloat
        var agentX: CGFloat
        var overlapsTitle: Bool
    }

    let gap: CGFloat = 4
    let progressGap: CGFloat = 7

    private func metrics(proposal: ProposedViewSize, subviews: Subviews) -> Metrics {
        guard subviews.count >= 3 else {
            return Metrics(title: .zero, progress: .zero, agents: [], agentStride: 0,
                           agentsWidth: 0, agentX: 0, overlapsTitle: false)
        }
        let idealTitle = subviews[0].sizeThatFits(.unspecified)
        let available = max(0, proposal.width ?? idealTitle.width)
        let title = subviews[0].sizeThatFits(ProposedViewSize(width: available, height: nil))
        let agents = subviews.dropFirst(3).map { $0.sizeThatFits(.unspecified) }
        let fullAgentsWidth = agents.reduce(0) { $0 + $1.width }
        var stride: CGFloat = agents.first?.width ?? 0
        var agentsWidth = fullAgentsWidth
        let needsOverlay = !agents.isEmpty && idealTitle.width + gap + fullAgentsWidth > available

        if agents.count > 1, needsOverlay {
            let naturalStride = agents.first!.width
            let compactStride = min(naturalStride - 1, max(8, naturalStride * 0.42))
            let widthLimitedStride = max(7, (min(128, max(agents.last!.width, available * 0.46)) - agents.last!.width) / CGFloat(agents.count - 1))
            stride = min(compactStride, widthLimitedStride)
            agentsWidth = agents.last!.width + stride * CGFloat(agents.count - 1)
        }

        let fitsAfterTitle = !needsOverlay
        let agentX = agents.isEmpty ? 0 : (fitsAfterTitle ? idealTitle.width + gap : max(0, available - agentsWidth))
        let progress = subviews[1].sizeThatFits(ProposedViewSize(width: title.width, height: nil))
        return Metrics(title: title, progress: progress, agents: agents,
                       agentStride: stride, agentsWidth: agentsWidth, agentX: agentX,
                       overlapsTitle: !fitsAfterTitle && !agents.isEmpty)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let value = metrics(proposal: proposal, subviews: subviews)
        let progressHeight = value.progress.height > 0 ? progressGap + value.progress.height : 0
        let width = max(value.title.width, value.agentX + value.agentsWidth)
        let tallestAgent = value.agents.map(\.height).max() ?? 0
        return CGSize(width: min(proposal.width ?? width, width),
                      height: max(value.title.height + progressHeight, tallestAgent - 2))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard subviews.count >= 3 else { return }
        let value = metrics(proposal: ProposedViewSize(width: bounds.width, height: bounds.height), subviews: subviews)
        subviews[0].place(at: CGPoint(x: bounds.minX, y: bounds.minY), proposal: ProposedViewSize(value.title))
        subviews[1].place(at: CGPoint(x: bounds.minX, y: bounds.minY + value.title.height + progressGap),
                          proposal: ProposedViewSize(width: value.title.width, height: value.progress.height))
        let blurLead: CGFloat = value.overlapsTitle ? 26 : 0
        subviews[2].place(at: CGPoint(x: bounds.minX + value.agentX - blurLead, y: bounds.minY - 4),
                          proposal: ProposedViewSize(width: value.overlapsTitle ? value.agentsWidth + blurLead : 0,
                                                     height: value.overlapsTitle ? 28 : 0))
        var x = bounds.minX + value.agentX
        for (index, size) in value.agents.enumerated() {
            subviews[index + 3].place(at: CGPoint(x: x, y: bounds.minY - 2), proposal: ProposedViewSize(size))
            x += index == value.agents.count - 1 ? size.width : value.agentStride
        }
    }
}

struct AgentBlurBackdrop: View {
    var body: some View {
        ZStack {
            Rectangle()
                .fill(.regularMaterial)
                .opacity(0.72)
            LinearGradient(colors: [CodexPalette.surface.opacity(0.08), CodexPalette.surface.opacity(0.68)],
                           startPoint: .leading, endPoint: .trailing)
        }
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .blur(radius: 2.2)
            .mask(LinearGradient(stops: [
                .init(color: .clear, location: 0),
                .init(color: .black.opacity(0.62), location: 0.16),
                .init(color: .black, location: 0.34)
            ], startPoint: .leading, endPoint: .trailing))
            .allowsHitTesting(false)
    }
}

struct AnimatedStepNote: View {
    var text: String
    private let animationStart = Date()

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
            let elapsed = max(0, context.date.timeIntervalSince(animationStart))
            let linear = min(1, elapsed / 0.30)
            let eased = linear * linear * (3 - 2 * linear)
            Text(text)
                .font(.system(size: 11))
                .foregroundStyle(CodexPalette.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .opacity(eased)
                .blur(radius: 2.5 * (1 - eased))
                .offset(y: 3 * (1 - eased))
                .id(text)
            }
    }
}

struct StepRow: View {
    var step: Step

    var body: some View {
        HStack(alignment: .top, spacing: PanelMetrics.columnGap) {
            Group {
                StatusIcon(status: step.status, animationKey: step.id + "|" + step.title).id(step.status)
            }
            .frame(width: PanelMetrics.iconColumn, height: PanelMetrics.iconColumn)

            VStack(alignment: .leading, spacing: 3) {
                StepHeadLayout {
                    Text(step.title)
                        .font(.system(size: 13, weight: step.status == "in_progress" ? .semibold : .regular))
                        .foregroundStyle(step.status == "completed" ? CodexPalette.secondary : CodexPalette.stepPrimary)
                        .strikethrough(step.status == "completed", color: CodexPalette.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if step.status == "in_progress", let value = step.progress {
                        ThinProgressBar(value: value)
                    } else {
                        Color.clear.frame(height: 0)
                    }
                    AgentBlurBackdrop()
                    if let agents = step.agents {
                        ForEach(Array(agents.enumerated()), id: \.offset) { index, agent in
                            AgentIcon(agent: agent)
                                .zIndex(agent.status == "completed" ? 100 + Double(index) : Double(index))
                        }
                    } else if let worker = step.worker {
                        Text(worker)
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(CodexPalette.blue)
                    }
                }
                if let note = step.note, !note.isEmpty {
                    AnimatedStepNote(text: note)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 3)
    }
}

struct PlanEmojiCircle: View {
    @ObservedObject var store: Store
    var plan: Plan
    var size: CGFloat = 30
    var highlighted = false
    var glyphSize: CGFloat = PanelMetrics.planIconGlyph

    var body: some View {
        ZStack {
            Circle().fill(highlighted && plan.status != "completed" ? Color.white.opacity(0.055) : .clear)
            Text(planEmoji(plan))
                .font(.system(size: min(glyphSize, size * 0.75)))
                .multilineTextAlignment(.center)
                .offset(y: 0.5)
        }
            .frame(width: size, height: size)
            .overlay {
                if plan.status == "completed" {
                    PlanCompletionLifecycle(
                        animationKey: plan.id + "|" + (plan.completedAt ?? "terminal"),
                        completedAt: plan.completedAt.flatMap(parseISODate),
                        diameter: size + 4,
                        deadline: store.retentionDeadlines[plan.id],
                        retentionDuration: store.retentionDuration,
                        hovered: highlighted
                    )
                }
            }
            .contentShape(Circle())
            .onTapGesture {
                guard plan.status == "completed" else { return }
                store.removeRequested?(plan.id)
            }
            .accessibilityLabel(plan.title)
    }
}

struct PlanCompletionLifecycle: View {
    var animationKey: String
    var completedAt: Date?
    var diameter: CGFloat
    var deadline: Date?
    var retentionDuration: TimeInterval
    var hovered: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
            let age = reduceMotion ? completionCheckDuration : elapsed(at: context.date)
            ZStack {
                if age >= completionCheckDuration {
                    let fraction = remainingFraction(at: context.date)
                    Circle()
                        .trim(from: 1 - fraction, to: 1)
                        .stroke(CodexPalette.primary.opacity(0.42),
                                style: StrokeStyle(lineWidth: 1.2, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                    Circle()
                        .fill(.regularMaterial)
                        .opacity(hovered ? 0.94 : 0)
                        .blur(radius: hovered ? 2.2 : 0)
                    Image(systemName: "xmark")
                        .font(.system(size: diameter * 0.34, weight: .semibold))
                        .foregroundStyle(CodexPalette.primary)
                        .opacity(hovered ? 1 : 0)
                        .scaleEffect(hovered ? 1 : 0.72)
                } else {
                    let grow = eased(min(1, age / 0.48))
                    let blurOpacity = 0.94 * (1 - grow)
                    let fadeStart = completionCheckDuration - 0.18
                    let checkOpacity = age <= fadeStart ? 1 : max(0, 1 - (age - fadeStart) / 0.18)
                    Circle()
                        .fill(.regularMaterial)
                        .opacity(blurOpacity)
                        .blur(radius: blurOpacity * 3)
                    Image(systemName: "checkmark")
                        .font(.system(size: diameter * 0.48, weight: .heavy))
                        .foregroundStyle(CodexPalette.statusGreen)
                        .scaleEffect(1 + 0.34 * grow)
                        .opacity(checkOpacity)
                }
            }
        }
        .frame(width: diameter, height: diameter)
        .id(animationKey)
    }

    private func elapsed(at now: Date) -> TimeInterval {
        guard let completedAt else { return completionCheckDuration }
        return max(0, now.timeIntervalSince(completedAt))
    }

    private func eased(_ value: TimeInterval) -> CGFloat {
        CGFloat(1 - pow(1 - value, 3))
    }

    private func remainingFraction(at now: Date) -> CGFloat {
        guard let deadline else { return 1 }
        return CGFloat(max(0, min(1, deadline.timeIntervalSince(now) / max(0.1, retentionDuration))))
    }

}

struct CollapsedPlanView: View {
    @ObservedObject var store: Store

    var body: some View {
        ZStack {
            Circle()
                .fill(CodexPalette.raised.opacity(store.collapsedHovered ? 0.92 : 0.68))
                .overlay(Circle().stroke(Color.white.opacity(store.collapsedHovered ? 0.24 : 0.17), lineWidth: 1))
                .scaleEffect(store.collapsedHovered ? 1.12 : 1)
                .animation(.spring(response: 0.2, dampingFraction: 0.72), value: store.collapsedHovered)
            if let active = store.active {
                PlanEmojiCircle(store: store, plan: active, size: 38,
                                highlighted: store.collapsedHovered,
                                glyphSize: PanelMetrics.planIconGlyph)
                    .overlay(alignment: .bottomTrailing) {
                        if store.plans.count > 1 {
                            Text("+\(store.plans.count - 1)")
                                .font(.system(size: 7, weight: .bold))
                                .monospacedDigit()
                                .foregroundStyle(CodexPalette.primary)
                                .padding(.horizontal, 3)
                                .frame(minWidth: 14, minHeight: 12)
                                .background(Capsule().fill(CodexPalette.raised))
                                .overlay(Capsule().stroke(CodexPalette.border, lineWidth: 0.6))
                                .offset(x: 3, y: 3)
                        }
                    }
            }
        }
        .padding(5)
        .contentShape(Circle())
        .preferredColorScheme(.dark)
    }
}

final class TransitionIconAnimation: ObservableObject {
    @Published var compactProgress: CGFloat

    init(compactProgress: CGFloat) {
        self.compactProgress = compactProgress
    }
}

struct TransitionPlanView: View {
    @ObservedObject var store: Store
    @StateObject private var animation: TransitionIconAnimation
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(store: Store) {
        self.store = store
        _animation = StateObject(wrappedValue: TransitionIconAnimation(
            compactProgress: store.transitionToCollapsed ? 0 : 1
        ))
    }

    var body: some View {
        GeometryReader { geometry in
            let compact = animation.compactProgress
            let shellInset = 5 * compact
            let shellRadius = 16 + 5 * compact
            ZStack(alignment: .topLeading) {
                RoundedRectangle(cornerRadius: shellRadius, style: .continuous)
                    .fill(CodexPalette.surface)
                    .overlay(CodexPalette.raised.opacity(0.68 * compact)
                        .clipShape(RoundedRectangle(cornerRadius: shellRadius, style: .continuous)))
                    .overlay(RoundedRectangle(cornerRadius: shellRadius, style: .continuous)
                        .stroke(CodexPalette.border.opacity(1 - compact), lineWidth: 1))
                    .overlay(RoundedRectangle(cornerRadius: shellRadius, style: .continuous)
                        .stroke(Color.white.opacity(0.17 * compact), lineWidth: 1))
                    .padding(shellInset)
                    .frame(width: geometry.size.width, height: geometry.size.height)

                if let active = store.active {
                    ZStack {
                        PlanEmojiCircle(store: store, plan: active, size: 38,
                                        highlighted: store.collapsedHovered || store.hoveredPlanID == active.id,
                                        glyphSize: PanelMetrics.planIconGlyph)
                            .overlay(alignment: .bottomTrailing) {
                                if store.plans.count > 1 {
                                    Text("+\(store.plans.count - 1)")
                                        .font(.system(size: 7, weight: .bold))
                                        .monospacedDigit()
                                        .foregroundStyle(CodexPalette.primary)
                                        .padding(.horizontal, 3)
                                        .frame(minWidth: 14, minHeight: 12)
                                        .background(Capsule().fill(CodexPalette.raised))
                                        .overlay(Capsule().stroke(CodexPalette.border, lineWidth: 0.6))
                                        .offset(x: 3, y: 3)
                                        .opacity(compact)
                                }
                            }
                        }
                    .frame(width: 52, height: 52)
                    .offset(x: -2 * (1 - compact), y: -2 * (1 - compact))
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height, alignment: .topLeading)
        }
        .onAppear { animateTowardCurrentDirection() }
        .onChange(of: store.transitionToCollapsed) { _, _ in animateTowardCurrentDirection() }
    }

    private func animateTowardCurrentDirection() {
        withAnimation(reduceMotion ? nil : .timingCurve(0.22, 0.8, 0.3, 1, duration: 0.22)) {
            animation.compactProgress = store.transitionToCollapsed ? 1 : 0
        }
    }
}

struct CompanionRootView: View {
    @ObservedObject var store: Store

    @ViewBuilder var body: some View {
        if store.collapsed {
            CollapsedPlanView(store: store)
        } else if store.transitionIconOnly {
            TransitionPlanView(store: store)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else {
            PanelView(store: store)
        }
    }
}

final class SpaceMirrorState: ObservableObject {
    @Published var collapsed = true
}

struct SpaceMirrorRootView: View {
    @ObservedObject var store: Store
    @ObservedObject var state: SpaceMirrorState

    @ViewBuilder var body: some View {
        if state.collapsed {
            CollapsedPlanView(store: store)
        } else {
            PanelView(store: store)
        }
    }
}

struct PlanIconSwitcher: View {
    @ObservedObject var store: Store

    private var otherPlans: [Plan] {
        store.plans.filter { $0.id != store.selected }
    }

    var body: some View {
        ZStack(alignment: .leading) {
            Color.clear.frame(width: PanelMetrics.iconColumn, height: PanelMetrics.iconColumn)
            if let active = store.active {
                if store.hoveredPlanID != nil {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(CodexPalette.raised.opacity(0.96))
                        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .stroke(CodexPalette.border, lineWidth: 0.7))
                        .frame(width: PanelMetrics.iconColumn + 12 + (store.planSwitcherExpanded ? CGFloat(otherPlans.count) * 28 : 0),
                               height: 34)
                        .offset(x: -6)
                        .transition(.scale(scale: 0.72, anchor: .leading).combined(with: .opacity))
                        .animation(.spring(response: 0.26, dampingFraction: 0.86), value: store.planSwitcherExpanded)
                        .zIndex(0)
                }
                HStack(spacing: 4) {
                    PlanEmojiCircle(store: store, plan: active, size: PanelMetrics.iconColumn,
                                    highlighted: store.hoveredPlanID == active.id)
                        .overlay(alignment: .bottomTrailing) {
                            if !store.planSwitcherExpanded, !otherPlans.isEmpty {
                                Text("+\(otherPlans.count)")
                                    .font(.system(size: 7, weight: .bold))
                                    .monospacedDigit()
                                    .foregroundStyle(CodexPalette.primary)
                                    .padding(.horizontal, 3)
                                    .frame(minWidth: 14, minHeight: 12)
                                    .background(Capsule().fill(CodexPalette.raised))
                                    .overlay(Capsule().stroke(CodexPalette.border, lineWidth: 0.6))
                                    .offset(x: 4, y: 3)
                            }
                        }
                    if store.planSwitcherExpanded {
                        ForEach(Array(otherPlans.enumerated()), id: \.element.id) { index, plan in
                            Button {
                                store.select(plan.id)
                                withAnimation(.easeOut(duration: 0.14)) { store.planSwitcherExpanded = false }
                            } label: {
                                PlanEmojiCircle(store: store, plan: plan, size: PanelMetrics.iconColumn,
                                                highlighted: store.hoveredPlanID == plan.id)
                            }
                            .buttonStyle(.plain)
                            .transition(.offset(x: -16).combined(with: .opacity))
                            .zIndex(Double(otherPlans.count - index))
                        }
                    }
                }
                .contentShape(Rectangle())
                .zIndex(1)
            }
        }
        .frame(width: PanelMetrics.iconColumn, height: PanelMetrics.iconColumn, alignment: .leading)
        .zIndex(10)
        .accessibilityLabel("Текущий план и переключатель планов")
    }
}

struct PanelView: View {
    @ObservedObject var store: Store
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let plan = store.active {
                HStack(alignment: .center, spacing: PanelMetrics.columnGap) {
                    PlanIconSwitcher(store: store)
                    HStack(alignment: .center, spacing: 10) {
                        Text(plan.title)
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(CodexPalette.primary)
                            .fixedSize(horizontal: false, vertical: true)
                            .layoutPriority(1)
                        Spacer(minLength: 6)
                        Text("\(plan.done) из \(plan.steps.count)")
                            .monospacedDigit()
                            .foregroundStyle(CodexPalette.secondary)
                            .font(.system(size: 10, weight: .medium))
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(Capsule().fill(Color.white.opacity(0.035)))
                            .overlay(Capsule().stroke(CodexPalette.border, lineWidth: 0.7))
                            .fixedSize()
                    }
                }
                .padding(.horizontal, PanelMetrics.inset)
                .padding(.top, PanelMetrics.inset)
                .padding(.bottom, PanelMetrics.headerBottom)
                .frame(maxWidth: .infinity, alignment: .leading)
                Rectangle()
                    .fill(CodexPalette.border)
                    .frame(height: PanelMetrics.headerDivider)
                    .padding(.horizontal, PanelMetrics.inset)
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(plan.steps) { step in
                                StepRow(step: step).id(step.id)
                            }
                        }
                        .padding(.horizontal, PanelMetrics.inset)
                        .padding(.top, 4)
                        .padding(.bottom, PanelMetrics.inset)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: .infinity)
                    .background(CodexPalette.stepsSurface)
                    .onAppear {
                        guard let active = plan.steps.first(where: { $0.status == "in_progress" }) else { return }
                        DispatchQueue.main.async { proxy.scrollTo(active.id, anchor: .center) }
                    }
                    .onChange(of: plan.revision) { _, _ in
                        guard let active = plan.steps.first(where: { $0.status == "in_progress" }) else { return }
                        DispatchQueue.main.async {
                            withAnimation(.easeOut(duration: 0.28)) { proxy.scrollTo(active.id, anchor: .center) }
                        }
                    }
                }
            }
        }.frame(minWidth: 280, maxWidth: .infinity, minHeight: 240, maxHeight: .infinity, alignment: .topLeading)
            .background(CodexPalette.surface)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(CodexPalette.border, lineWidth: 1))
            .preferredColorScheme(.dark)
    }
}
final class PlanPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

struct PlanTooltipContent: View {
    var title: String

    var body: some View {
        Text(title)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(CodexPalette.primary)
            .lineLimit(2)
            .truncationMode(.tail)
            .fixedSize(horizontal: false, vertical: true)
            .frame(minWidth: 72, maxWidth: 220, alignment: .leading)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color(red: 42 / 255, green: 42 / 255, blue: 44 / 255).opacity(0.98)))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(Color(red: 66 / 255, green: 66 / 255, blue: 69 / 255), lineWidth: 0.7))
    }
}

final class PlanTooltipPanel {
    private(set) var title: String?
    private let panel: NSPanel
    private let host: NSHostingView<PlanTooltipContent>
    private var animationToken = 0
    private var isHiding = false

    init() {
        panel = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .floating
        panel.ignoresMouseEvents = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        panel.alphaValue = 0
        panel.appearance = NSAppearance(named: .darkAqua)

        host = NSHostingView(rootView: PlanTooltipContent(title: ""))
        host.wantsLayer = true
        host.layer?.backgroundColor = NSColor.clear.cgColor
        panel.contentView = host
    }

    var isVisible: Bool { panel.isVisible }
    var frame: NSRect { panel.frame }
    var hoverRegion: NSRect { panel.frame.insetBy(dx: -5, dy: -7) }

    func show(_ value: String, below iconFrame: NSRect) {
        host.rootView = PlanTooltipContent(title: value)
        host.layoutSubtreeIfNeeded()
        let fitting = host.fittingSize
        let width = min(240, max(92, ceil(fitting.width)))
        let height = min(52, max(29, ceil(fitting.height)))
        panel.setContentSize(NSSize(width: width, height: height))
        host.frame = NSRect(origin: .zero, size: NSSize(width: width, height: height))

        let visible = NSScreen.screens.first(where: { $0.frame.intersects(iconFrame) })?.visibleFrame
            ?? NSScreen.main?.visibleFrame ?? iconFrame
        let idealX = iconFrame.midX - width / 2
        let x = min(max(idealX, visible.minX + 4), visible.maxX - width - 4)
        let y = max(visible.minY + 6, iconFrame.minY - height - 8)
        panel.setFrameOrigin(NSPoint(x: x, y: y))
        let needsEntrance = !panel.isVisible || title != value || isHiding
        animationToken += 1
        isHiding = false
        title = value
        if needsEntrance {
            panel.alphaValue = 0
            panel.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.15
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                panel.animator().alphaValue = 1
            }
        } else {
            panel.alphaValue = 1
        }
    }

    func hide(animated: Bool = false) {
        guard panel.isVisible else { title = nil; isHiding = false; return }
        guard animated else {
            animationToken += 1
            isHiding = false
            title = nil
            panel.alphaValue = 0
            panel.orderOut(nil)
            return
        }
        guard !isHiding else { return }
        animationToken += 1
        let token = animationToken
        isHiding = true
        title = nil
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.13
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            panel.animator().alphaValue = 0
        } completionHandler: { [weak self] in
            guard let self, self.animationToken == token else { return }
            self.panel.orderOut(nil)
            self.isHiding = false
        }
    }

    func writeSnapshot(to url: URL) throws {
        guard let content = panel.contentView else { throw NSError(domain: "Tooltip snapshot unavailable", code: 10) }
        content.layoutSubtreeIfNeeded()
        guard let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds) else {
            throw NSError(domain: "Tooltip snapshot unavailable", code: 10)
        }
        content.cacheDisplay(in: content.bounds, to: bitmap)
        try bitmap.representation(using: .png, properties: [:])?.write(to: url)
    }
}

final class PanelHostingView<Content: View>: NSHostingView<Content> {
    let resizeCursorZoneCount = 8
    var resizeEnabled = true
    var windowDragEnabled = false

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var mouseDownCanMoveWindow: Bool { windowDragEnabled }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        window?.acceptsMouseMovedEvents = true
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        if resizeCursorKind(at: point) != nil { return self }
        return super.hitTest(point)
    }

    func resizeCursorKind(at point: NSPoint) -> String? {
        guard resizeEnabled else { return nil }
        let edge: CGFloat = 18
        let corner: CGFloat = 18
        guard bounds.contains(point) else { return nil }
        let left = point.x <= edge, right = point.x >= bounds.width - edge
        let top = isFlipped ? point.y <= edge : point.y >= bounds.height - edge
        let bottom = isFlipped ? point.y >= bounds.height - edge : point.y <= edge
        let nearTop = isFlipped ? point.y <= corner : point.y >= bounds.height - corner
        let nearBottom = isFlipped ? point.y >= bounds.height - corner : point.y <= corner
        if point.x <= corner && nearBottom { return "bottom-left" }
        if point.x >= bounds.width - corner && nearBottom { return "bottom-right" }
        if point.x <= corner && nearTop { return "top-left" }
        if point.x >= bounds.width - corner && nearTop { return "top-right" }
        if left { return "left" }
        if right { return "right" }
        if bottom { return "bottom" }
        if top { return "top" }
        return nil
    }

    func resizeCursor(for kind: String?) -> NSCursor {
        guard let kind else { return .arrow }
        if ["left", "right"].contains(kind) { return .resizeLeftRight }
        if ["top", "bottom"].contains(kind) { return .resizeUpDown }
        if #available(macOS 15.0, *) {
            switch kind {
            case "bottom-left": return .frameResize(position: .bottomLeft, directions: .all)
            case "bottom-right": return .frameResize(position: .bottomRight, directions: .all)
            case "top-left": return .frameResize(position: .topLeft, directions: .all)
            case "top-right": return .frameResize(position: .topRight, directions: .all)
            default: return .arrow
            }
        }
        return .crosshair
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        guard let kind = resizeCursorKind(at: point), let window else {
            super.mouseDown(with: event)
            return
        }
        let initialFrame = window.frame
        let initialMouse = NSEvent.mouseLocation
        let minSize = resizeEnabled
            ? NSSize(width: PanelMetrics.minimumWidth, height: PanelMetrics.minimumHeight)
            : window.minSize
        while let next = window.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]) {
            if next.type == .leftMouseUp { break }
            let current = NSEvent.mouseLocation
            let dx = current.x - initialMouse.x
            let dy = current.y - initialMouse.y
            var frame = initialFrame
            if kind.contains("left") {
                frame.size.width = max(minSize.width, initialFrame.width - dx)
                frame.origin.x = initialFrame.maxX - frame.width
            } else if kind.contains("right") {
                frame.size.width = max(minSize.width, initialFrame.width + dx)
            }
            if kind.contains("bottom") {
                frame.size.height = max(minSize.height, initialFrame.height - dy)
                frame.origin.y = initialFrame.maxY - frame.height
            } else if kind.contains("top") {
                frame.size.height = max(minSize.height, initialFrame.height + dy)
            }
            window.setFrame(frame, display: true)
            resizeCursor(for: kind).set()
        }
    }

    override func resetCursorRects() {
        super.resetCursorRects()
        discardCursorRects()
        guard resizeEnabled else { return }
        let edge: CGFloat = 18
        let corner: CGFloat = 18
        let horizontalWidth = max(0, bounds.width - corner * 2)
        let verticalHeight = max(0, bounds.height - corner * 2)
        let topY: CGFloat = isFlipped ? 0 : bounds.height - edge
        let bottomY: CGFloat = isFlipped ? bounds.height - edge : 0
        addCursorRect(NSRect(x: corner, y: bottomY, width: horizontalWidth, height: edge), cursor: resizeCursor(for: "bottom"))
        addCursorRect(NSRect(x: corner, y: topY, width: horizontalWidth, height: edge), cursor: resizeCursor(for: "top"))
        addCursorRect(NSRect(x: 0, y: corner, width: edge, height: verticalHeight), cursor: resizeCursor(for: "left"))
        addCursorRect(NSRect(x: bounds.width - edge, y: corner, width: edge, height: verticalHeight), cursor: resizeCursor(for: "right"))
        addCursorRect(NSRect(x: 0, y: bottomY, width: corner, height: corner), cursor: resizeCursor(for: "bottom-left"))
        addCursorRect(NSRect(x: bounds.width - corner, y: bottomY, width: corner, height: corner), cursor: resizeCursor(for: "bottom-right"))
        addCursorRect(NSRect(x: 0, y: topY, width: corner, height: corner), cursor: resizeCursor(for: "top-left"))
        addCursorRect(NSRect(x: bounds.width - corner, y: topY, width: corner, height: corner), cursor: resizeCursor(for: "top-right"))
    }
}

final class Delegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let store = Store()
    var panel: PlanPanel!
    var hostView: PanelHostingView<CompanionRootView>!
    let spaceRouter = SpaceWindowRouter()
    let spaceMirrorState = SpaceMirrorState()
    var spaceMirrorPanel: PlanPanel!
    var spaceMirrorHostView: PanelHostingView<SpaceMirrorRootView>!
    var spaceRemoteIconPanel: PlanPanel!
    var spaceRemoteIconHostView: PanelHostingView<CollapsedPlanView>!
    var observers: [NSObjectProtocol] = []
    var localEventMonitor: Any?
    var dismissed = false
    var listener: Int32 = -1
    var instanceLock: Int32 = -1
    var socketPath = ""
    var dataURL: URL!
    var restoredFrame: WindowFrame?
    var restoredExpandedFrame: WindowFrame?
    var restoredUnfocusedExpandedFrame: WindowFrame?
    var restoredCollapsedFrame: WindowFrame?
    var expandedFrame: NSRect?
    var unfocusedExpandedFrame: NSRect?
    var collapsedFrame: NSRect?
    var focusCollapseEnabled = false
    var retentionStartedAt: [String: Date] = [:]
    let hostBundle = ProcessInfo.processInfo.environment["PLAN_COMPANION_HOST"] ?? "com.openai.codex"
    var lastVisibility: Bool?
    var expiryTimer: Timer?
    var cursorTimer: Timer?
    let planTooltip = PlanTooltipPanel()
    var liveCursorKind: String?
    var suppressingFallbackResizeCursor = false
    var suppressResizeActivationUntilPointerExit = false
    var planHoverExitStartedAt: Date?
    var collapsedHoverStartedAt: Date?
    var expandedHoverExitStartedAt: Date?
    var expandedFromIconSource: NSRect?
    var expandedMovedBeyondSource = false
    var applyingPresentationFrame = false
    var collapsingToIcon = false
    var collapsedDragInProgress = false
    var collapsedHoverBlockedUntilExit = false
    var hostPresenceObserved = false
    var hostMissingStartedAt: Date?
    var presentationAnimationToken = 0
    var presentationTween: PresentationTween?
    var pendingPresentationSync = false
    var workspaceGestureGeneration = 0
    var lastEarlyPresentationSignal: String?
    var lastEarlyPresentationSignalAt: Date?
    var hostWindowObservationInitialized = false
    var lastHostWindowObservation: HostWindowObservation?
    var lastHostWindowPollAt = Date.distantPast
    var earlyHostDepartureBaseline: HostWindowObservation?
    var earlyHostDepartureReturnSamples = 0
    var spaceDepartureActive = false
    var spaceArrivalPending = false
    var awayFromHostSpace = false
    var spaceOriginWasCollapsed: Bool?
    var hostSpaceID: UInt64?
    var spaceMirrorVisible = false
    var spaceRemoteIconVisible = false
    var hostMinimizeBaseline: HostWindowObservation?
    var hostMinimizeCandidateSamples = 0
    var hostMinimizingActive = false
    var hostWindowMinimized = false
    var lastHostMinimizeTrigger: String?
    let retentionSeconds = max(0.1, Double(ProcessInfo.processInfo.environment["PLAN_COMPANION_RETENTION_SECONDS"] ?? "") ?? 30)
    let collapsedSize = NSSize(width: 52, height: 52)
    let expandedMinimumSize = NSSize(width: PanelMetrics.minimumWidth, height: PanelMetrics.minimumHeight)
    let collapsedExpandDelay: TimeInterval = 0.70

    func terminalDate(_ plan: Plan) -> Date? {
        guard ["completed", "cancelled"].contains(plan.status ?? "") else { return nil }
        return parseISODate(plan.completedAt)
    }

    func expiryDate(_ plan: Plan) -> Date? {
        return terminalDate(plan)?.addingTimeInterval(retentionSeconds)
    }

    @discardableResult func pruneExpiredPlans(at now: Date = Date()) -> Bool {
        let count = store.plans.count
        store.plans.removeAll { plan in
            guard let expiry = expiryDate(plan) else { return false }
            return now >= expiry
        }
        guard store.plans.count != count else { return false }
        retentionStartedAt = retentionStartedAt.filter { id, _ in store.plans.contains(where: { $0.id == id }) }
        if let selected = store.selected, !store.plans.contains(where: { $0.id == selected }) {
            store.selected = store.plans.last?.id
        }
        return true
    }

    func scheduleExpiry() {
        expiryTimer?.invalidate(); expiryTimer = nil
        store.retentionDuration = retentionSeconds
        store.retentionDeadlines = Dictionary(uniqueKeysWithValues: store.plans.compactMap { plan in
            expiryDate(plan).map { (plan.id, $0) }
        })
        let now = Date()
        let next = store.plans.compactMap(expiryDate)
            .filter { $0 > now }.min()
        guard let next else { return }
        expiryTimer = Timer.scheduledTimer(withTimeInterval: max(0.05, next.timeIntervalSince(now)), repeats: false) { [weak self] _ in
            guard let self else { return }
            let removed = self.pruneExpiredPlans()
            if removed { try? self.persist(); self.syncPresentation(); self.journal("plans_expired") }
            self.scheduleExpiry()
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let env = ProcessInfo.processInfo.environment
        let codexHome = env["CODEX_HOME"] ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex").path
        let data = env["PLAN_COMPANION_DATA"] ?? codexHome + "/task-plan/companion"
        let socket = env["PLAN_COMPANION_SOCKET"] ?? data + "/control.sock"
        dataURL = URL(fileURLWithPath: data); socketPath = socket
        do {
            try FileManager.default.createDirectory(at: dataURL, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            instanceLock = Darwin.open(dataURL.appendingPathComponent("instance.lock").path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
            guard instanceLock >= 0 && flock(instanceLock, LOCK_EX | LOCK_NB) == 0 else {
                throw NSError(domain: "Companion already running", code: 12)
            }
            if let data = try? Data(contentsOf: dataURL.appendingPathComponent("state.json")),
               let saved = try? JSONDecoder().decode(Saved.self, from: data) {
                let restoredAt = Date()
                store.plans = saved.plans.map { normalizedTerminalPlan($0, now: restoredAt) }
                store.selected = saved.selected
                store.creationWatermarks = saved.creationWatermarks ?? [:]
                restoredFrame = saved.windowFrame
                restoredExpandedFrame = saved.expandedWindowFrame ?? saved.windowFrame
                restoredUnfocusedExpandedFrame = saved.unfocusedExpandedWindowFrame
                    ?? saved.expandedWindowFrame ?? saved.windowFrame
                restoredCollapsedFrame = saved.collapsedWindowFrame
                focusCollapseEnabled = saved.collapseWhenUnfocused
                    ?? (env["PLAN_COMPANION_FOCUS_COLLAPSE"] == "1")
                retentionStartedAt = (saved.retentionStartedAt ?? [:]).compactMapValues(parseISODate)
            } else {
                focusCollapseEnabled = env["PLAN_COMPANION_FOCUS_COLLAPSE"] == "1"
            }
            try startSocket()
        } catch { fputs("Startup failed: \(error)\n", stderr); NSApp.terminate(nil); return }
        NSApp.setActivationPolicy(.accessory)
        panel = PlanPanel(contentRect: NSRect(x: 0, y: 0, width: 420, height: 430),
                          styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "Task Plan Companion"
        panel.delegate = self; panel.isReleasedWhenClosed = false
        panel.level = .floating; panel.hidesOnDeactivate = false; panel.becomesKeyOnlyIfNeeded = true
        panel.collectionBehavior = [.fullScreenAuxiliary]
        panel.titleVisibility = .hidden; panel.titlebarAppearsTransparent = true
        panel.standardWindowButton(.closeButton)?.isHidden = true
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true
        panel.isMovableByWindowBackground = true
        panel.minSize = collapsedSize
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.isOpaque = false
        panel.hasShadow = false
        panel.backgroundColor = .clear
        hostView = PanelHostingView(rootView: CompanionRootView(store: store))
        if #available(macOS 13.0, *) {
            hostView.sizingOptions = []
        }
        panel.contentView = hostView
        panel.enableCursorRects()
        spaceMirrorPanel = PlanPanel(contentRect: NSRect(origin: .zero, size: collapsedSize),
                                     styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        spaceMirrorPanel.title = "Task Plan Host Space Mirror"
        spaceMirrorPanel.isReleasedWhenClosed = false
        spaceMirrorPanel.level = .floating
        spaceMirrorPanel.hidesOnDeactivate = false
        spaceMirrorPanel.becomesKeyOnlyIfNeeded = true
        spaceMirrorPanel.collectionBehavior = [.fullScreenAuxiliary]
        spaceMirrorPanel.isMovableByWindowBackground = false
        spaceMirrorPanel.appearance = NSAppearance(named: .darkAqua)
        spaceMirrorPanel.isOpaque = false
        spaceMirrorPanel.hasShadow = false
        spaceMirrorPanel.backgroundColor = .clear
        spaceMirrorPanel.ignoresMouseEvents = true
        spaceMirrorHostView = PanelHostingView(rootView: SpaceMirrorRootView(store: store, state: spaceMirrorState))
        spaceMirrorHostView.resizeEnabled = false
        spaceMirrorHostView.windowDragEnabled = false
        if #available(macOS 13.0, *) {
            spaceMirrorHostView.sizingOptions = []
        }
        spaceMirrorPanel.contentView = spaceMirrorHostView
        spaceMirrorPanel.orderOut(nil)
        spaceRemoteIconPanel = PlanPanel(contentRect: NSRect(origin: .zero, size: collapsedSize),
                                         styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        spaceRemoteIconPanel.title = "Task Plan Remote Space Icon"
        spaceRemoteIconPanel.isReleasedWhenClosed = false
        spaceRemoteIconPanel.level = .floating
        spaceRemoteIconPanel.hidesOnDeactivate = false
        spaceRemoteIconPanel.becomesKeyOnlyIfNeeded = true
        spaceRemoteIconPanel.collectionBehavior = [.fullScreenAuxiliary, .stationary]
        spaceRemoteIconPanel.isMovableByWindowBackground = false
        spaceRemoteIconPanel.appearance = NSAppearance(named: .darkAqua)
        spaceRemoteIconPanel.isOpaque = false
        spaceRemoteIconPanel.hasShadow = false
        spaceRemoteIconPanel.backgroundColor = .clear
        spaceRemoteIconPanel.ignoresMouseEvents = true
        spaceRemoteIconHostView = PanelHostingView(rootView: CollapsedPlanView(store: store))
        spaceRemoteIconHostView.resizeEnabled = false
        spaceRemoteIconHostView.windowDragEnabled = false
        if #available(macOS 13.0, *) {
            spaceRemoteIconHostView.sizingOptions = []
        }
        spaceRemoteIconPanel.contentView = spaceRemoteIconHostView
        spaceRemoteIconPanel.orderOut(nil)
        cursorTimer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
            self?.syncPresentationAnimation()
            self?.syncHostLifecycle()
            self?.syncLiveResizeCursor()
            self?.syncPlanSwitcherHover()
            self?.syncCollapsedHover()
            self?.syncExpandedHoverExit()
            self?.syncWorkspaceWindowMotion()
        }
        cursorTimer?.tolerance = 1.0 / 120
        if let cursorTimer { RunLoop.main.add(cursorTimer, forMode: .common) }
        localEventMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown]) { [weak self] event in
            guard let self else { return event }
            let pointer = NSEvent.mouseLocation
            if let selected = self.planSwitcherSelection(at: pointer) {
                if self.completedPlanIsReady(selected) {
                    if self.trackPointerClick(from: event) {
                        _ = self.removeCompletedPlanIfReady(selected)
                    }
                    return nil
                }
                self.store.select(selected)
                return nil
            }
            if self.activePlanIconContains(pointer), let selected = self.store.selected,
               self.completedPlanIsReady(selected) {
                if self.trackPointerClick(from: event) {
                    _ = self.removeCompletedPlanIfReady(selected)
                }
                return nil
            }
            if self.panel.frame.contains(pointer), self.canBeginWindowDrag(at: pointer) {
                let wasCollapsed = self.store.collapsed
                let activeAtDragStart = self.store.active?.id
                if wasCollapsed {
                    self.collapsedDragInProgress = true
                    self.store.collapsedHovered = false
                    self.collapsedHoverStartedAt = nil
                }
                let wasClick = !self.trackWindowDrag(from: event)
                if wasCollapsed {
                    self.collapsedDragInProgress = false
                    self.collapsedHoverBlockedUntilExit = true
                    if wasClick, let activeAtDragStart {
                        if !self.removeCompletedPlanIfReady(activeAtDragStart) {
                            self.restoreHostFocusAfterPointerRelease()
                        }
                    }
                } else if wasClick {
                    self.restoreHostFocusAfterPointerRelease()
                }
                return nil
            }
            if self.panel.frame.contains(pointer) {
                self.restoreHostFocusAfterPointerRelease()
            }
            return event
        }
        store.changed = { [weak self] in self?.stateChanged() }
        store.removeRequested = { [weak self] id in
            _ = self?.removeCompletedPlanIfReady(id)
        }
        let center = NSWorkspace.shared.notificationCenter
        observers.append(center.addObserver(forName: NSWorkspace.didActivateApplicationNotification,
                                             object: nil, queue: .main) { [weak self] note in
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            guard let self else { return }
            self.workspaceGestureGeneration += 1
            let hostActivated = app?.bundleIdentifier == self.hostBundle
            if hostActivated, self.spaceArrivalPending || self.awayFromHostSpace {
                self.restoreHostSpacePresentation()
            } else if self.awayFromHostSpace {
                self.syncPresentation()
            } else {
                self.syncPresentation(hostDidActivate: hostActivated)
            }
        })
        observers.append(center.addObserver(forName: NSWorkspace.didDeactivateApplicationNotification,
                                             object: nil, queue: .main) { [weak self] note in
            guard let self,
                  let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  app.bundleIdentifier == self.hostBundle else { return }
            DispatchQueue.main.async { [weak self] in
                guard let self,
                      NSWorkspace.shared.frontmostApplication?.bundleIdentifier != Bundle.main.bundleIdentifier else { return }
                if self.spaceDepartureActive || self.awayFromHostSpace {
                    self.journal("space_departure_settled")
                } else {
                    self.beginEarlyPresentationTransition(source: "host-deactivated", requireHostFrontmost: false)
                }
            }
        })
        observers.append(center.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification,
                                             object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.workspaceGestureGeneration += 1
            let hostIsFrontmost = NSWorkspace.shared.frontmostApplication?.bundleIdentifier == self.hostBundle
            if hostIsFrontmost, self.spaceArrivalPending || self.awayFromHostSpace {
                self.restoreHostSpacePresentation()
            } else if self.spaceDepartureActive {
                self.finishSpaceDeparture()
            } else if self.awayFromHostSpace {
                self.syncPresentation()
            } else {
                self.spaceArrivalPending = false
                self.spaceDepartureActive = false
                self.syncPresentation()
            }
        })
        observers.append(center.addObserver(forName: NSWorkspace.didTerminateApplicationNotification,
                                             object: nil, queue: .main) { [weak self] note in
            guard let self,
                  let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  app.bundleIdentifier == self.hostBundle else { return }
            self.journal("host_terminated")
            NSApp.terminate(nil)
        })
        syncHostLifecycle()
        if let frame = validRestoredExpandedFrame() {
            expandedFrame = frame
            panel.setFrame(frame, display: false)
        } else if let screen = NSScreen.main {
            panel.setFrameTopLeftPoint(NSPoint(x: screen.visibleFrame.maxX - 430, y: screen.visibleFrame.maxY - 65))
            expandedFrame = panel.frame
        }
        unfocusedExpandedFrame = validRestoredUnfocusedExpandedFrame()
        collapsedFrame = validRestoredCollapsedFrame()
        if pruneExpiredPlans() { try? persist() }
        scheduleExpiry()
        syncPresentation(); journal("started")
        print("READY \(socketPath)"); fflush(stdout)
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { dismissed = true; panel.orderOut(nil); journal("dismissed"); return false }
    func windowDidMove(_ notification: Notification) {
        guard !applyingPresentationFrame, !store.transitionIconOnly, !collapsingToIcon else { return }
        if store.collapsed {
            collapsedFrame = panel.frame
        } else {
            guard panel.frame.width >= expandedMinimumSize.width,
                  panel.frame.height >= expandedMinimumSize.height else { return }
            if let source = expandedFromIconSource {
                unfocusedExpandedFrame = panel.frame
                let icon = planIconFrame(in: panel.frame)
                if expandedMovedBeyondSource || !icon.intersects(source) {
                    expandedMovedBeyondSource = true
                    collapsedFrame = clampedCollapsedFrame(centeredAt: NSPoint(x: icon.midX, y: icon.midY))
                }
            } else {
                expandedFrame = panel.frame
            }
        }
        try? persist()
    }
    func windowDidResize(_ notification: Notification) {
        guard !applyingPresentationFrame, !store.collapsed,
              !store.transitionIconOnly, !collapsingToIcon else { return }
        guard panel.frame.width >= expandedMinimumSize.width,
              panel.frame.height >= expandedMinimumSize.height else { return }
        if expandedFromIconSource != nil { unfocusedExpandedFrame = panel.frame }
        else { expandedFrame = panel.frame }
        try? persist()
    }

    func planIconFrame(in frame: NSRect) -> NSRect {
        NSRect(x: frame.minX + PanelMetrics.inset,
               y: frame.maxY - PanelMetrics.inset - PanelMetrics.iconColumn,
               width: PanelMetrics.iconColumn, height: PanelMetrics.iconColumn)
    }

    func canBeginWindowDrag(at point: NSPoint) -> Bool {
        guard panel.frame.contains(point) else { return false }
        if store.collapsed { return true }
        let local = hostView.convert(panel.convertPoint(fromScreen: point), from: nil)
        guard hostView.resizeCursorKind(at: local) == nil else { return false }

        // The plan icon strip remains interactive; every other non-resize part of
        // this read-only panel is a dependable drag surface, including title text.
        let iconOriginX = panel.frame.minX + PanelMetrics.inset
        let iconOriginY = panel.frame.maxY - PanelMetrics.inset - PanelMetrics.iconColumn - 6
        let planCount = max(1, store.plans.count)
        let stripWidth = PanelMetrics.iconColumn + 8
            + (store.planSwitcherExpanded ? CGFloat(planCount - 1) * (PanelMetrics.iconColumn + 4) : 0)
        let iconStrip = NSRect(x: iconOriginX - 4, y: iconOriginY,
                               width: stripWidth, height: PanelMetrics.iconColumn + 12)
        return !iconStrip.contains(point)
    }

    @discardableResult func trackWindowDrag(from event: NSEvent) -> Bool {
        let initialFrame = panel.frame
        let initialPointer = NSEvent.mouseLocation
        var didDrag = false
        while let next = panel.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]) {
            if next.type == .leftMouseUp { break }
            let pointer = NSEvent.mouseLocation
            let dx = pointer.x - initialPointer.x
            let dy = pointer.y - initialPointer.y
            if !didDrag, hypot(dx, dy) < 3 { continue }
            didDrag = true
            panel.setFrameOrigin(NSPoint(x: initialFrame.minX + dx,
                                         y: initialFrame.minY + dy))
        }
        if didDrag, !spaceDepartureActive, !awayFromHostSpace,
           NSWorkspace.shared.frontmostApplication?.bundleIdentifier == hostBundle {
            _ = primeRemoteSpaceIcon()
        }
        return didDrag
    }

    func trackPointerClick(from event: NSEvent, slop: CGFloat = 6) -> Bool {
        let initialPointer = NSEvent.mouseLocation
        var maximumDistance: CGFloat = 0
        while let next = panel.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]) {
            let pointer = NSEvent.mouseLocation
            maximumDistance = max(maximumDistance,
                                  hypot(pointer.x - initialPointer.x,
                                        pointer.y - initialPointer.y))
            if next.type == .leftMouseUp { return maximumDistance <= slop }
        }
        return false
    }

    func planSwitcherSelection(at point: NSPoint) -> String? {
        guard !store.collapsed, store.planSwitcherExpanded else { return nil }
        let otherPlans = store.plans.filter { $0.id != store.selected }
        guard !otherPlans.isEmpty else { return nil }
        let stride = PanelMetrics.iconColumn + 4
        let firstX = panel.frame.minX + PanelMetrics.inset + stride
        let zoneY = panel.frame.maxY - PanelMetrics.inset - PanelMetrics.iconColumn - 6
        guard point.y >= zoneY, point.y <= zoneY + PanelMetrics.iconColumn + 12,
              point.x >= firstX else { return nil }
        let index = Int((point.x - firstX) / stride)
        guard otherPlans.indices.contains(index) else { return nil }
        let itemX = firstX + CGFloat(index) * stride
        guard point.x <= itemX + PanelMetrics.iconColumn else { return nil }
        return otherPlans[index].id
    }

    func activePlanIconContains(_ point: NSPoint) -> Bool {
        guard !store.collapsed, panel.frame.contains(point) else { return false }
        let originX = panel.frame.minX + PanelMetrics.inset
        let zoneY = panel.frame.maxY - PanelMetrics.inset - PanelMetrics.iconColumn - 6
        return NSRect(x: originX - 4, y: zoneY,
                      width: PanelMetrics.iconColumn + 8,
                      height: PanelMetrics.iconColumn + 12).contains(point)
    }

    @discardableResult func removeCompletedPlanIfReady(_ id: String) -> Bool {
        guard completedPlanIsReady(id) else { return false }
        removePlan(id, event: "plan_removed_by_user")
        return true
    }

    func completedPlanIsReady(_ id: String, at now: Date = Date()) -> Bool {
        guard let plan = store.plans.first(where: { $0.id == id }),
              plan.status == "completed" else { return false }
        guard let completedAt = plan.completedAt.flatMap(parseISODate) else { return true }
        return now.timeIntervalSince(completedAt) >= completionCheckDuration
    }

    func removePlan(_ id: String, event: String) {
        guard store.plans.contains(where: { $0.id == id }) else { return }
        store.plans.removeAll { $0.id == id }
        retentionStartedAt.removeValue(forKey: id)
        if store.selected == id { store.selected = store.plans.last?.id }
        stateChanged()
        journal(event)
    }

    func screenFor(_ frame: NSRect) -> NSScreen? {
        NSScreen.screens.first(where: { $0.visibleFrame.intersects(frame) }) ?? NSScreen.main
    }

    func clamped(_ frame: NSRect, to visible: NSRect) -> NSRect {
        var result = frame
        result.size.width = min(result.width, visible.width)
        result.size.height = min(result.height, visible.height)
        result.origin.x = min(max(result.minX, visible.minX), visible.maxX - result.width)
        result.origin.y = min(max(result.minY, visible.minY), visible.maxY - result.height)
        return result
    }

    func clampedCollapsedFrame(centeredAt center: NSPoint) -> NSRect {
        let candidate = NSRect(x: center.x - collapsedSize.width / 2,
                               y: center.y - collapsedSize.height / 2,
                               width: collapsedSize.width, height: collapsedSize.height)
        let visible = screenFor(candidate)?.visibleFrame ?? candidate
        return clamped(candidate, to: visible)
    }

    func defaultCollapsedFrame() -> NSRect {
        let source = expandedFrame ?? panel.frame
        let icon = planIconFrame(in: source)
        return clampedCollapsedFrame(centeredAt: NSPoint(x: icon.midX, y: icon.midY))
    }

    func fittedExpandedFrame(near iconFrame: NSRect? = nil) -> NSRect {
        var candidate = iconFrame == nil
            ? (expandedFrame ?? panel.frame)
            : (unfocusedExpandedFrame ?? expandedFrame ?? panel.frame)
        guard let iconFrame else {
            let screen = screenFor(candidate) ?? NSScreen.main
            return screen.map { clamped(candidate, to: $0.visibleFrame) } ?? candidate
        }
        let iconCenter = NSPoint(x: iconFrame.midX, y: iconFrame.midY)
        candidate.origin.x = iconCenter.x - PanelMetrics.inset - PanelMetrics.iconColumn / 2
        candidate.origin.y = iconCenter.y - candidate.height + PanelMetrics.inset + PanelMetrics.iconColumn / 2
        let screen = screenFor(iconFrame) ?? NSScreen.main
        return screen.map { clamped(candidate, to: $0.visibleFrame) } ?? candidate
    }

    func applyPresentationFrame(_ frame: NSRect, alpha: CGFloat, animated: Bool,
                                completion: (() -> Void)? = nil) {
        presentationAnimationToken += 1
        let token = presentationAnimationToken
        applyingPresentationFrame = true
        if animated {
            hostView.layoutSubtreeIfNeeded()
            panel.contentView?.displayIfNeeded()
            presentationTween = PresentationTween(
                token: token,
                fromFrame: panel.frame,
                toFrame: frame,
                fromAlpha: panel.alphaValue,
                toAlpha: alpha,
                startedAt: ProcessInfo.processInfo.systemUptime,
                duration: 0.22,
                completion: completion
            )
            syncPresentationAnimation()
        } else {
            presentationTween = nil
            panel.setFrame(frame, display: true)
            panel.alphaValue = alpha
            DispatchQueue.main.async { [weak self] in
                guard let self, self.presentationAnimationToken == token else { return }
                self.applyingPresentationFrame = false
                completion?()
            }
        }
    }

    func syncPresentationAnimation() {
        guard let tween = presentationTween else { return }
        guard tween.token == presentationAnimationToken else {
            presentationTween = nil
            return
        }
        let elapsed = ProcessInfo.processInfo.systemUptime - tween.startedAt
        let linear = min(1, max(0, elapsed / tween.duration))
        let eased = CGFloat(1 - pow(1 - linear, 3))
        func value(_ from: CGFloat, _ to: CGFloat) -> CGFloat {
            from + (to - from) * eased
        }
        let frame = NSRect(
            x: value(tween.fromFrame.minX, tween.toFrame.minX),
            y: value(tween.fromFrame.minY, tween.toFrame.minY),
            width: value(tween.fromFrame.width, tween.toFrame.width),
            height: value(tween.fromFrame.height, tween.toFrame.height)
        )
        panel.setFrame(frame, display: true)
        panel.alphaValue = value(tween.fromAlpha, tween.toAlpha)
        panel.displayIfNeeded()
        guard linear >= 1 else { return }
        presentationTween = nil
        applyingPresentationFrame = false
        tween.completion?()
    }

    func schedulePresentationFrame(_ frame: NSRect, alpha: CGFloat, animated: Bool,
                                   completion: (() -> Void)? = nil) {
        presentationAnimationToken += 1
        let reservation = presentationAnimationToken
        applyingPresentationFrame = true
        DispatchQueue.main.async { [weak self] in
            guard let self, self.presentationAnimationToken == reservation else { return }
            self.applyPresentationFrame(frame, alpha: alpha, animated: animated, completion: completion)
        }
    }

    func finishCollapse(to target: NSRect) {
        guard collapsingToIcon else { return }
        collapsingToIcon = false
        store.collapsed = true
        store.transitionIconOnly = false
        hostView.resizeEnabled = false
        hostView.windowDragEnabled = true
        panel.minSize = collapsedSize
        panel.setFrame(target, display: true)
        panel.alphaValue = 0.82
        try? persist()
        journal("collapsed")
        settlePendingPresentationSync()
    }

    func settlePendingPresentationSync() {
        guard pendingPresentationSync else { return }
        pendingPresentationSync = false
        DispatchQueue.main.async { [weak self] in self?.syncPresentation() }
    }

    func finishExpansion(to target: NSRect, resizeEnabled: Bool) {
        let token = presentationAnimationToken
        applyingPresentationFrame = true
        DispatchQueue.main.async { [weak self] in
            guard let self, self.presentationAnimationToken == token,
                  !self.store.collapsed, !self.collapsingToIcon else { return }
            self.store.transitionIconOnly = false
            self.store.collapsedHovered = false
            self.panel.minSize = self.collapsedSize
            self.panel.setFrame(target, display: true)
            self.hostView.resizeEnabled = resizeEnabled
            self.hostView.windowDragEnabled = false
            self.applyingPresentationFrame = false
            self.settlePendingPresentationSync()
        }
    }

    func collapseToIcon(animated: Bool = false) {
        guard store.active != nil else { panel.orderOut(nil); return }
        guard !store.collapsed, !collapsingToIcon else { panel.orderFrontRegardless(); return }
        let target = collapsedFrame ?? defaultCollapsedFrame()
        collapsedFrame = target
        if expandedFromIconSource != nil,
           panel.frame.width >= expandedMinimumSize.width,
           panel.frame.height >= expandedMinimumSize.height {
            unfocusedExpandedFrame = panel.frame
        }
        expandedFromIconSource = nil
        expandedMovedBeyondSource = false
        expandedHoverExitStartedAt = nil
        store.planSwitcherExpanded = false
        store.hoveredPlanID = nil
        planTooltip.hide(animated: true)
        collapsingToIcon = true
        store.transitionToCollapsed = true
        store.transitionIconOnly = true
        hostView.resizeEnabled = false
        hostView.windowDragEnabled = true
        panel.minSize = collapsedSize
        panel.orderFrontRegardless()
        schedulePresentationFrame(target, alpha: 0.82, animated: animated) { [weak self] in
            self?.finishCollapse(to: target)
        }
    }

    func compactMainWindowForSpaceRouting() {
        guard store.active != nil else { return }
        guard !store.collapsed || collapsingToIcon || presentationTween != nil else {
            panel.alphaValue = 0
            return
        }
        let target = collapsedFrame ?? defaultCollapsedFrame()
        collapsedFrame = target
        if expandedFromIconSource != nil,
           panel.frame.width >= expandedMinimumSize.width,
           panel.frame.height >= expandedMinimumSize.height {
            unfocusedExpandedFrame = panel.frame
        }
        presentationAnimationToken += 1
        presentationTween = nil
        applyingPresentationFrame = false
        collapsingToIcon = false
        expandedFromIconSource = nil
        expandedMovedBeyondSource = false
        expandedHoverExitStartedAt = nil
        store.planSwitcherExpanded = false
        store.hoveredPlanID = nil
        store.collapsedHovered = false
        store.transitionToCollapsed = false
        store.transitionIconOnly = false
        store.collapsed = true
        planTooltip.hide(animated: false)
        hostView.resizeEnabled = false
        hostView.windowDragEnabled = true
        panel.minSize = collapsedSize
        panel.alphaValue = 0
        panel.setFrame(target, display: false)
        hostView.rootView = CompanionRootView(store: store)
        hostView.layoutSubtreeIfNeeded()
        panel.contentView?.displayIfNeeded()
        try? persist()
    }

    func expandForHost(animated: Bool = true) {
        guard store.active != nil else { panel.orderOut(nil); return }
        guard store.collapsed || collapsingToIcon else {
            if applyingPresentationFrame {
                panel.orderFrontRegardless()
                return
            }
            if expandedFromIconSource != nil {
                unfocusedExpandedFrame = panel.frame
                let target = fittedExpandedFrame()
                expandedFromIconSource = nil
                expandedMovedBeyondSource = false
                expandedHoverExitStartedAt = nil
                store.collapsedHovered = false
                hostView.resizeEnabled = false
                hostView.windowDragEnabled = false
                panel.orderFrontRegardless()
                schedulePresentationFrame(target, alpha: 1, animated: animated) { [weak self] in
                    self?.finishExpansion(to: target, resizeEnabled: true)
                }
                try? persist()
                journal("expanded_host_position_restored")
                return
            }
            expandedFromIconSource = nil
            expandedMovedBeyondSource = false
            expandedHoverExitStartedAt = nil
            hostView.resizeEnabled = true
            hostView.windowDragEnabled = false
            panel.minSize = collapsedSize
            panel.alphaValue = 1
            panel.orderFrontRegardless()
            return
        }
        let target = fittedExpandedFrame()
        store.transitionToCollapsed = false
        store.transitionIconOnly = true
        schedulePresentationFrame(target, alpha: 1, animated: animated) { [weak self] in
            self?.finishExpansion(to: target, resizeEnabled: true)
        }
        collapsingToIcon = false
        store.collapsed = false
        store.collapsedHovered = false
        collapsedHoverStartedAt = nil
        expandedFromIconSource = nil
        expandedMovedBeyondSource = false
        expandedHoverExitStartedAt = nil
        hostView.resizeEnabled = false
        hostView.windowDragEnabled = false
        panel.minSize = collapsedSize
        panel.orderFrontRegardless()
        try? persist()
        journal("expanded_host")
    }

    func expandFromCollapsedIcon() {
        guard store.collapsed, !collapsedDragInProgress, store.active != nil else { return }
        let source = panel.frame
        let target = fittedExpandedFrame(near: source)
        collapsedFrame = source
        store.hoveredPlanID = store.selected
        store.transitionToCollapsed = false
        store.transitionIconOnly = true
        schedulePresentationFrame(target, alpha: 1, animated: true) { [weak self] in
            self?.finishExpansion(to: target, resizeEnabled: false)
        }
        store.collapsed = false
        collapsingToIcon = false
        collapsedHoverStartedAt = nil
        expandedFromIconSource = source
        expandedMovedBeyondSource = false
        expandedHoverExitStartedAt = nil
        hostView.resizeEnabled = false
        hostView.windowDragEnabled = false
        panel.minSize = collapsedSize
        panel.orderFrontRegardless()
        try? persist()
        journal("expanded_hover")
    }

    func beginEarlyPresentationTransition(source: String, requireHostFrontmost: Bool = true) {
        guard focusCollapseEnabled, store.active != nil, !dismissed else { return }
        if requireHostFrontmost {
            guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == hostBundle else { return }
        }
        workspaceGestureGeneration += 1
        lastEarlyPresentationSignal = source
        lastEarlyPresentationSignalAt = Date()
        collapseToIcon(animated: true)
        journal("early_presentation_transition")
    }

    func beginSpaceDeparture() {
        guard focusCollapseEnabled, store.active != nil, !dismissed else { return }
        guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == hostBundle else { return }
        guard !spaceDepartureActive, !awayFromHostSpace else { return }
        guard let spaceRouter, let currentSpace = spaceRouter.activeSpace() else {
            journal("space_routing_unavailable")
            return
        }
        let displaySpaces = spaceRouter.displaySpaces(containing: currentSpace)
        let nonHostSpaces = displaySpaces.filter { $0 != currentSpace }
        guard !nonHostSpaces.isEmpty else { return }
        let remoteIconReady = primeRemoteSpaceIcon(hostSpace: currentSpace)
        workspaceGestureGeneration += 1
        spaceOriginWasCollapsed = store.collapsed
        hostSpaceID = currentSpace
        spaceDepartureActive = true
        spaceArrivalPending = false
        lastEarlyPresentationSignal = "host-window-motion-leaving"
        lastEarlyPresentationSignalAt = Date()
        spaceMirrorState.collapsed = store.collapsed
        spaceMirrorPanel.setFrame(panel.frame, display: true)
        spaceMirrorPanel.alphaValue = panel.alphaValue
        spaceMirrorPanel.orderFrontRegardless()
        guard spaceRouter.assign(windowNumber: spaceMirrorPanel.windowNumber, to: [currentSpace]) else {
            spaceDepartureActive = false
            spaceOriginWasCollapsed = nil
            hostSpaceID = nil
            spaceMirrorPanel.orderOut(nil)
            journal("space_routing_failed")
            return
        }
        spaceMirrorVisible = true
        compactMainWindowForSpaceRouting()
        guard spaceRouter.assign(windowNumber: panel.windowNumber, to: nonHostSpaces) else {
            spaceDepartureActive = false
            spaceOriginWasCollapsed = nil
            hostSpaceID = nil
            hideSpaceMirror()
            syncPresentation()
            journal("space_routing_failed")
            return
        }
        panel.alphaValue = remoteIconReady ? 0 : 0.82
        journal("space_departure_started")
    }

    func hideSpaceMirror() {
        spaceMirrorPanel?.orderOut(nil)
        spaceMirrorVisible = false
    }

    func hideRemoteSpaceIcon() {
        spaceRemoteIconPanel?.orderOut(nil)
        spaceRemoteIconVisible = false
    }

    @discardableResult func primeRemoteSpaceIcon(hostSpace explicitHostSpace: UInt64? = nil) -> Bool {
        guard focusCollapseEnabled, store.active != nil, !dismissed,
              let spaceRouter,
              let hostSpace = explicitHostSpace ?? spaceRouter.activeSpace() else {
            hideRemoteSpaceIcon()
            return false
        }
        let remoteSpaces = spaceRouter.displaySpaces(containing: hostSpace).filter { $0 != hostSpace }
        guard !remoteSpaces.isEmpty else {
            hideRemoteSpaceIcon()
            return false
        }
        let targetSet = Set(remoteSpaces)
        let assignedSet = Set(spaceRouter.spaces(for: spaceRemoteIconPanel.windowNumber))
        let targetFrame = collapsedFrame ?? defaultCollapsedFrame()
        if spaceRemoteIconVisible, assignedSet == targetSet,
           spaceRemoteIconPanel.frame.equalTo(targetFrame) {
            return true
        }
        spaceRemoteIconPanel.alphaValue = 0
        spaceRemoteIconPanel.setFrame(targetFrame, display: false)
        spaceRemoteIconHostView.rootView = CollapsedPlanView(store: store)
        spaceRemoteIconHostView.layoutSubtreeIfNeeded()
        spaceRemoteIconPanel.contentView?.displayIfNeeded()
        spaceRemoteIconPanel.orderFrontRegardless()
        guard spaceRouter.assignVisibleWindow(windowNumber: spaceRemoteIconPanel.windowNumber,
                                              from: hostSpace, to: remoteSpaces),
              spaceRouter.activeSpace() == hostSpace else {
            hideRemoteSpaceIcon()
            journal("space_remote_icon_routing_failed")
            return false
        }
        spaceRemoteIconPanel.alphaValue = 0.82
        spaceRemoteIconVisible = true
        journal("space_remote_icon_primed")
        return true
    }

    func finishSpaceDeparture() {
        guard spaceDepartureActive else { return }
        spaceDepartureActive = false
        awayFromHostSpace = true
        spaceArrivalPending = false
        panel.alphaValue = 0.82
        panel.orderFrontRegardless()
        hideRemoteSpaceIcon()
        journal("space_departure_finished")
    }

    func cancelSpaceDeparture() {
        guard spaceDepartureActive else { return }
        workspaceGestureGeneration += 1
        spaceDepartureActive = false
        spaceArrivalPending = false
        awayFromHostSpace = false
        earlyHostDepartureBaseline = nil
        earlyHostDepartureReturnSamples = 0
        restoreHostSpacePresentation(event: "space_departure_cancelled")
    }

    func restoreHostSpacePresentation(event: String? = nil) {
        let restoreCollapsed = spaceOriginWasCollapsed ?? false
        guard let hostSpaceID, let spaceRouter else {
            spaceArrivalPending = false
            spaceDepartureActive = false
            awayFromHostSpace = false
            spaceOriginWasCollapsed = nil
            hideSpaceMirror()
            syncPresentation()
            journal("space_restore_routing_unavailable")
            return
        }
        spaceArrivalPending = false
        spaceDepartureActive = false
        awayFromHostSpace = false
        earlyHostDepartureBaseline = nil
        earlyHostDepartureReturnSamples = 0
        panel.alphaValue = 0
        guard spaceRouter.assign(windowNumber: panel.windowNumber, to: [hostSpaceID]) else {
            panel.alphaValue = store.collapsed ? 0.82 : 1
            panel.orderFrontRegardless()
            journal("space_restore_routing_failed")
            return
        }
        if restoreCollapsed {
            if store.collapsed {
                panel.alphaValue = 0.82
                panel.orderFrontRegardless()
            } else {
                collapseToIcon(animated: false)
            }
        } else if store.collapsed || collapsingToIcon {
            expandForHost(animated: false)
        } else {
            panel.alphaValue = 1
            panel.orderFrontRegardless()
        }
        _ = primeRemoteSpaceIcon(hostSpace: hostSpaceID)
        spaceOriginWasCollapsed = nil
        self.hostSpaceID = nil
        DispatchQueue.main.async { [weak self] in self?.hideSpaceMirror() }
        journal(event ?? (restoreCollapsed ? "space_arrival_restored_collapsed" : "space_arrival_restored_expanded"))
    }

    func beginHostMinimize(from baseline: HostWindowObservation, trigger: String) {
        guard focusCollapseEnabled, store.active != nil, !dismissed else { return }
        hostMinimizeBaseline = baseline
        hostMinimizingActive = true
        hostWindowMinimized = false
        hostMinimizeCandidateSamples = 0
        lastHostMinimizeTrigger = trigger
        lastEarlyPresentationSignal = "host-window-minimizing"
        lastEarlyPresentationSignalAt = Date()
        collapseToIcon(animated: true)
        journal("host_minimize_started")
    }

    func beginHostRestore() {
        guard focusCollapseEnabled, store.active != nil, store.collapsed, !dismissed else { return }
        hostWindowMinimized = false
        hostMinimizingActive = false
        hostMinimizeCandidateSamples = 0
        lastEarlyPresentationSignal = "host-window-restoring"
        lastEarlyPresentationSignalAt = Date()
        expandForHost(animated: true)
        journal("host_restore_started")
    }

    func primaryHostWindowObservation() -> HostWindowObservation? {
        guard let hostPID = NSRunningApplication.runningApplications(withBundleIdentifier: hostBundle)
                .first?.processIdentifier,
              let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements],
                                                    kCGNullWindowID) as? [[String: Any]] else { return nil }
        return rows.compactMap { row -> HostWindowObservation? in
            guard (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == hostPID,
                  (row[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                  let dictionary = row[kCGWindowBounds as String] as? NSDictionary,
                  let frame = CGRect(dictionaryRepresentation: dictionary),
                  frame.width >= 240, frame.height >= 160 else { return nil }
            return HostWindowObservation(id: (row[kCGWindowNumber as String] as? NSNumber)?.intValue ?? -1,
                                         frame: frame)
        }.max { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
    }

    func noteSpaceArrival() {
        guard focusCollapseEnabled, store.active != nil, store.collapsed, !dismissed else { return }
        guard !spaceArrivalPending else { return }
        spaceArrivalPending = true
        lastEarlyPresentationSignal = "host-window-motion-arriving"
        lastEarlyPresentationSignalAt = Date()
        journal("space_arrival_observed")
    }

    func hostWindowIsMeaningfullyVisible(_ observation: HostWindowObservation) -> Bool {
        let required = min(48, observation.frame.width * 0.04)
        return NSScreen.screens.contains { screen in
            let overlap = max(0, min(observation.frame.maxX, screen.frame.maxX)
                - max(observation.frame.minX, screen.frame.minX))
            return overlap >= required
        }
    }

    func hostWindowReturnedToDepartureBaseline(_ current: HostWindowObservation?) -> Bool {
        guard let baseline = earlyHostDepartureBaseline, let current,
              baseline.id == current.id else {
            earlyHostDepartureReturnSamples = 0
            return false
        }
        let returned = abs(current.frame.minX - baseline.frame.minX) <= 4
            && abs(current.frame.minY - baseline.frame.minY) <= 4
        earlyHostDepartureReturnSamples = returned ? earlyHostDepartureReturnSamples + 1 : 0
        return earlyHostDepartureReturnSamples >= 2
    }

    func syncWorkspaceWindowMotion() {
        guard panel != nil, focusCollapseEnabled, store.active != nil, !dismissed else {
            if let hostSpaceID, let spaceRouter, panel != nil {
                _ = spaceRouter.assign(windowNumber: panel.windowNumber, to: [hostSpaceID])
            }
            hostWindowObservationInitialized = false
            lastHostWindowObservation = nil
            earlyHostDepartureBaseline = nil
            earlyHostDepartureReturnSamples = 0
            hostMinimizeBaseline = nil
            hostMinimizeCandidateSamples = 0
            hostMinimizingActive = false
            hostWindowMinimized = false
            spaceDepartureActive = false
            spaceArrivalPending = false
            awayFromHostSpace = false
            spaceOriginWasCollapsed = nil
            hostSpaceID = nil
            hideSpaceMirror()
            hideRemoteSpaceIcon()
            return
        }
        let now = Date()
        guard now.timeIntervalSince(lastHostWindowPollAt) >= 1.0 / 30.0 else { return }
        lastHostWindowPollAt = now
        let current = primaryHostWindowObservation()
        guard hostWindowObservationInitialized else {
            hostWindowObservationInitialized = true
            lastHostWindowObservation = current
            return
        }
        defer { lastHostWindowObservation = current }
        let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier

        if hostWindowMinimized, lastHostWindowObservation == nil, current != nil {
            beginHostRestore()
            return
        }
        if hostMinimizingActive {
            if current == nil {
                hostMinimizingActive = false
                hostWindowMinimized = true
                journal("host_minimized")
            } else if let baseline = hostMinimizeBaseline,
                      current!.id == baseline.id,
                      current!.frame.width * current!.frame.height
                        >= baseline.frame.width * baseline.frame.height * 0.98 {
                hostMinimizingActive = false
                hostWindowMinimized = false
                hostMinimizeBaseline = nil
                if store.collapsed { expandForHost(animated: true) }
                journal("host_minimize_cancelled")
            }
            return
        }

        if front == hostBundle, !store.collapsed, !collapsingToIcon,
           NSEvent.pressedMouseButtons & 1 == 0,
           let previous = lastHostWindowObservation, current == nil {
            beginHostMinimize(from: previous, trigger: "window-disappeared-fallback")
            hostWindowMinimized = true
            hostMinimizingActive = false
            journal("host_minimized")
            return
        }

        if front == hostBundle, !store.collapsed, !collapsingToIcon,
           NSEvent.pressedMouseButtons & 1 == 0,
           let previous = lastHostWindowObservation, let current,
           previous.id == current.id {
            let widthDelta = current.frame.width - previous.frame.width
            let heightDelta = current.frame.height - previous.frame.height
            if widthDelta <= -8, heightDelta <= -6 {
                if hostMinimizeCandidateSamples == 0 { hostMinimizeBaseline = previous }
                hostMinimizeCandidateSamples += 1
                if let baseline = hostMinimizeBaseline,
                   hostMinimizeCandidateSamples >= 2,
                   current.frame.width * current.frame.height
                    <= baseline.frame.width * baseline.frame.height * 0.92 {
                    beginHostMinimize(from: baseline, trigger: "proportional-shrink")
                }
                return
            }
            hostMinimizeCandidateSamples = 0
            hostMinimizeBaseline = nil
        }

        if front == hostBundle, !spaceDepartureActive, !awayFromHostSpace,
           NSEvent.pressedMouseButtons & 1 == 0,
           let previous = lastHostWindowObservation, let current,
           previous.id == current.id {
            let deltaX = current.frame.minX - previous.frame.minX
            let deltaY = current.frame.minY - previous.frame.minY
            if abs(deltaX) >= 8, abs(deltaX) > abs(deltaY) * 2 {
                earlyHostDepartureBaseline = previous
                earlyHostDepartureReturnSamples = 0
                beginSpaceDeparture()
                return
            }
        }

        if front == hostBundle, spaceDepartureActive,
           hostWindowReturnedToDepartureBaseline(current) {
            cancelSpaceDeparture()
            return
        }
        if front != hostBundle, awayFromHostSpace,
           lastHostWindowObservation == nil, let current,
           hostWindowIsMeaningfullyVisible(current) {
            noteSpaceArrival()
        } else if front != hostBundle, spaceArrivalPending, current == nil {
            spaceArrivalPending = false
            journal("space_arrival_cancelled")
        }
    }

    func syncPresentation(hostDidActivate: Bool = false) {
        guard panel != nil else { return }
        if applyingPresentationFrame {
            pendingPresentationSync = true
            panel.orderFrontRegardless()
            return
        }
        guard store.active != nil, !dismissed else {
            hideSpaceMirror()
            hideRemoteSpaceIcon()
            panel.orderOut(nil)
            if lastVisibility != false { lastVisibility = false; journal("visibility") }
            return
        }
        if spaceDepartureActive {
            return
        }
        if awayFromHostSpace {
            panel.alphaValue = 0.82
            panel.orderFrontRegardless()
            return
        }
        let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        if !focusCollapseEnabled {
            hideRemoteSpaceIcon()
            let companion = Bundle.main.bundleIdentifier
            let visible = front == hostBundle || front == companion
            store.collapsed = false
            hostView.resizeEnabled = true
            hostView.windowDragEnabled = false
            panel.minSize = collapsedSize
            panel.alphaValue = 1
            if visible { panel.orderFrontRegardless() } else { panel.orderOut(nil) }
            if visible != lastVisibility { lastVisibility = visible; journal("visibility") }
            return
        }
        let companion = Bundle.main.bundleIdentifier
        if front == hostBundle {
            expandForHost(animated: store.collapsed)
            _ = primeRemoteSpaceIcon()
        } else if expandedFromIconSource != nil {
            hostView.resizeEnabled = false
            panel.orderFrontRegardless()
        } else if front == companion, !store.collapsed {
            panel.orderFrontRegardless()
        } else {
            collapseToIcon(animated: true)
        }
        let visible = panel.isVisible
        if visible != lastVisibility { lastVisibility = visible; journal("visibility") }
    }

    func syncHostLifecycle() {
        let running = !NSRunningApplication.runningApplications(withBundleIdentifier: hostBundle).isEmpty
        if running {
            hostPresenceObserved = true
            hostMissingStartedAt = nil
        } else if hostPresenceObserved, hostMissingStartedAt == nil {
            hostMissingStartedAt = Date()
        } else if let missingSince = hostMissingStartedAt,
                  Date().timeIntervalSince(missingSince) >= 0.75 {
            journal("host_terminated")
            NSApp.terminate(nil)
        }
    }

    func syncCollapsedHover() {
        guard focusCollapseEnabled, store.collapsed, !applyingPresentationFrame,
              panel.isVisible, store.active != nil else {
            if store.collapsedHovered { store.collapsedHovered = false }
            collapsedHoverStartedAt = nil
            return
        }
        let hovering = panel.frame.insetBy(dx: -5, dy: -5).contains(NSEvent.mouseLocation)
        if collapsedDragInProgress || NSEvent.pressedMouseButtons & 1 != 0 {
            if store.collapsedHovered { store.collapsedHovered = false }
            collapsedHoverStartedAt = nil
            return
        }
        if collapsedHoverBlockedUntilExit {
            if !hovering { collapsedHoverBlockedUntilExit = false }
            if store.collapsedHovered { store.collapsedHovered = false }
            collapsedHoverStartedAt = nil
            return
        }
        guard hovering else {
            if store.collapsedHovered { store.collapsedHovered = false }
            collapsedHoverStartedAt = nil
            return
        }
        if !store.collapsedHovered {
            store.collapsedHovered = true
            collapsedHoverStartedAt = Date()
            return
        }
        guard let started = collapsedHoverStartedAt,
              Date().timeIntervalSince(started) >= collapsedExpandDelay else { return }
        expandFromCollapsedIcon()
    }

    func syncExpandedHoverExit() {
        guard focusCollapseEnabled, !store.collapsed, !applyingPresentationFrame,
              expandedFromIconSource != nil,
              NSWorkspace.shared.frontmostApplication?.bundleIdentifier != hostBundle else {
            expandedHoverExitStartedAt = nil
            return
        }
        if NSEvent.pressedMouseButtons & 1 != 0 { expandedHoverExitStartedAt = nil; return }
        let pointer = NSEvent.mouseLocation
        let interactive = panel.frame.insetBy(dx: -6, dy: -6).contains(pointer)
            || (planTooltip.isVisible && planTooltip.hoverRegion.contains(pointer))
        if interactive { expandedHoverExitStartedAt = nil; return }
        if expandedHoverExitStartedAt == nil { expandedHoverExitStartedAt = Date(); return }
        guard Date().timeIntervalSince(expandedHoverExitStartedAt!) >= 0.28 else { return }
        collapseToIcon(animated: true)
    }

    func liveResizeCursorKind(at point: NSPoint) -> String? {
        guard panel?.isVisible == true, !store.collapsed, hostView.resizeEnabled else { return nil }
        let frame = panel.frame
        let edge: CGFloat = 18
        let corner: CGFloat = 18
        guard frame.contains(point) else { return nil }
        let x = point.x - frame.minX
        let y = point.y - frame.minY
        let left = abs(x) <= edge
        let right = abs(x - frame.width) <= edge
        let bottom = abs(y) <= edge
        let top = abs(y - frame.height) <= edge
        if left && y <= corner { return "bottom-left" }
        if right && y <= corner { return "bottom-right" }
        if left && y >= frame.height - corner { return "top-left" }
        if right && y >= frame.height - corner { return "top-right" }
        if left { return "left" }
        if right { return "right" }
        if bottom { return "bottom" }
        if top { return "top" }
        return nil
    }
    func syncLiveResizeCursor() {
        if store.collapsed || !hostView.resizeEnabled {
            if liveCursorKind != nil || suppressingFallbackResizeCursor {
                liveCursorKind = nil
                suppressingFallbackResizeCursor = false
                NSCursor.arrow.set()
            }
            return
        }
        let point = NSEvent.mouseLocation
        let kind = liveResizeCursorKind(at: point)
        if let kind {
            let entering = liveCursorKind == nil && !suppressingFallbackResizeCursor
            suppressingFallbackResizeCursor = false
            liveCursorKind = kind
            if entering && !suppressResizeActivationUntilPointerExit {
                NSApp.activate(ignoringOtherApps: true)
                panel.makeKeyAndOrderFront(nil)
            }
            hostView.resizeCursor(for: kind).set()
        } else if panel?.isVisible == true,
                  panel.frame.insetBy(dx: -8, dy: -8).contains(point),
                  !panel.frame.insetBy(dx: 22, dy: 22).contains(point) {
            let entering = liveCursorKind == nil && !suppressingFallbackResizeCursor
            liveCursorKind = nil
            suppressingFallbackResizeCursor = true
            if entering && !suppressResizeActivationUntilPointerExit {
                NSApp.activate(ignoringOtherApps: true)
                panel.makeKeyAndOrderFront(nil)
            }
            NSCursor.arrow.set()
        } else if liveCursorKind != nil || suppressingFallbackResizeCursor {
            liveCursorKind = nil
            suppressingFallbackResizeCursor = false
            suppressResizeActivationUntilPointerExit = false
            NSCursor.arrow.set()
            NSRunningApplication.runningApplications(withBundleIdentifier: hostBundle).first?
                .activate(options: [.activateAllWindows])
        } else if suppressResizeActivationUntilPointerExit {
            suppressResizeActivationUntilPointerExit = false
        }
    }
    func syncPlanSwitcherHover() {
        guard panel?.isVisible == true, !store.collapsed, let active = store.active else {
            planTooltip.hide()
            planHoverExitStartedAt = nil
            if store.hoveredPlanID != nil { store.hoveredPlanID = nil }
            if store.planSwitcherExpanded { store.planSwitcherExpanded = false }
            return
        }
        let frame = panel.frame
        let point = NSEvent.mouseLocation
        let originX = frame.minX + PanelMetrics.inset
        let zoneY = frame.maxY - PanelMetrics.inset - PanelMetrics.iconColumn - 6
        let activeZone = NSRect(x: originX - 4, y: zoneY, width: PanelMetrics.iconColumn + 8,
                                height: PanelMetrics.iconColumn + 12)
        let others = store.plans.filter { $0.id != active.id }
        let stride = PanelMetrics.iconColumn + 4
        let stripZone = NSRect(x: originX - 4, y: zoneY,
                               width: PanelMetrics.iconColumn + 8 + CGFloat(others.count) * stride,
                               height: PanelMetrics.iconColumn + 12)

        if activeZone.contains(point) {
            planTooltip.hide()
            planHoverExitStartedAt = nil
            if store.hoveredPlanID != active.id { store.hoveredPlanID = active.id }
            if !others.isEmpty, !store.planSwitcherExpanded {
                withAnimation(.spring(response: 0.26, dampingFraction: 0.86)) {
                    store.planSwitcherExpanded = true
                }
            }
            return
        }

        if store.planSwitcherExpanded, stripZone.contains(point) {
            planHoverExitStartedAt = nil
            let relativeX = point.x - (originX + stride)
            let index = Int(floor(relativeX / stride))
            let hovered = (0..<others.count).contains(index) ? others[index].id : nil
            if store.hoveredPlanID != hovered { store.hoveredPlanID = hovered }
            if (0..<others.count).contains(index) {
                let iconFrame = NSRect(x: originX + CGFloat(index + 1) * stride,
                                       y: frame.maxY - PanelMetrics.inset - PanelMetrics.iconColumn,
                                       width: PanelMetrics.iconColumn, height: PanelMetrics.iconColumn)
                planTooltip.show(others[index].title, below: iconFrame)
            } else {
                planTooltip.hide()
            }
            return
        }

        if planTooltip.isVisible, planTooltip.hoverRegion.union(stripZone).contains(point) {
            planHoverExitStartedAt = nil
            return
        }

        if planHoverExitStartedAt == nil {
            planHoverExitStartedAt = Date()
            planTooltip.hide(animated: true)
            if store.planSwitcherExpanded {
                withAnimation(.spring(response: 0.22, dampingFraction: 0.9)) {
                    store.planSwitcherExpanded = false
                }
            }
            return
        }
        guard Date().timeIntervalSince(planHoverExitStartedAt!) >= PanelMetrics.planHoverExitGrace else { return }
        planHoverExitStartedAt = nil
        if store.hoveredPlanID != nil {
            withAnimation(.easeOut(duration: 0.12)) {
                store.hoveredPlanID = nil
            }
        }
        if store.planSwitcherExpanded {
            withAnimation(.spring(response: 0.22, dampingFraction: 0.9)) {
                store.planSwitcherExpanded = false
            }
        }
    }
    func restoreHostFocusAfterPointerRelease(_ attempt: Int = 0) {
        guard attempt < 80 else { return }
        if NSEvent.pressedMouseButtons & 1 == 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in
                guard let self else { return }
                self.suppressResizeActivationUntilPointerExit = true
                NSApp.deactivate()
                NSRunningApplication.runningApplications(withBundleIdentifier: self.hostBundle).first?
                    .activate(options: [.activateAllWindows])
            }
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                self?.restoreHostFocusAfterPointerRelease(attempt + 1)
            }
        }
    }
    func stateChanged() {
        _ = pruneExpiredPlans()
        do { try persist() }
        catch { journal("persist_failed") }
        scheduleExpiry()
        syncPresentation(); journal("state_changed")
    }
    func persist() throws {
        let savedExpanded = expandedFrame.map { WindowFrame(x: $0.minX, y: $0.minY, width: $0.width, height: $0.height) }
        let currentUnfocusedExpanded = unfocusedExpandedFrame
            ?? (expandedFromIconSource != nil && !store.collapsed ? panel?.frame : nil)
        let savedUnfocusedExpanded = currentUnfocusedExpanded.map {
            WindowFrame(x: $0.minX, y: $0.minY, width: $0.width, height: $0.height)
        }
        let currentCollapsed = collapsedFrame ?? (store.collapsed ? panel?.frame : nil)
        let savedCollapsed = currentCollapsed.map { WindowFrame(x: $0.minX, y: $0.minY, width: $0.width, height: $0.height) }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let savedRetention = retentionStartedAt.mapValues { formatter.string(from: $0) }
        try JSONEncoder().encode(Saved(plans: store.plans, selected: store.selected,
                                      creationWatermarks: store.creationWatermarks,
                                      windowFrame: savedExpanded ?? restoredExpandedFrame ?? restoredFrame,
                                      expandedWindowFrame: savedExpanded ?? restoredExpandedFrame,
                                      unfocusedExpandedWindowFrame: savedUnfocusedExpanded ?? restoredUnfocusedExpandedFrame,
                                      collapsedWindowFrame: savedCollapsed ?? restoredCollapsedFrame,
                                      collapseWhenUnfocused: focusCollapseEnabled,
                                      retentionStartedAt: savedRetention))
            .write(to: dataURL.appendingPathComponent("state.json"), options: .atomic)
    }
    func validRestoredExpandedFrame() -> NSRect? {
        guard let saved = restoredExpandedFrame ?? restoredFrame,
              [saved.x, saved.y, saved.width, saved.height].allSatisfy({ $0.isFinite }),
              saved.width >= expandedMinimumSize.width, saved.height >= expandedMinimumSize.height else { return nil }
        let frame = NSRect(x: saved.x, y: saved.y, width: saved.width, height: saved.height)
        return NSScreen.screens.contains(where: { $0.visibleFrame.intersects(frame) }) ? frame : nil
    }
    func validRestoredUnfocusedExpandedFrame() -> NSRect? {
        guard let saved = restoredUnfocusedExpandedFrame,
              [saved.x, saved.y, saved.width, saved.height].allSatisfy({ $0.isFinite }),
              saved.width >= expandedMinimumSize.width, saved.height >= expandedMinimumSize.height else { return nil }
        let frame = NSRect(x: saved.x, y: saved.y, width: saved.width, height: saved.height)
        return NSScreen.screens.contains(where: { $0.visibleFrame.intersects(frame) }) ? frame : nil
    }
    func validRestoredCollapsedFrame() -> NSRect? {
        guard let saved = restoredCollapsedFrame,
              [saved.x, saved.y, saved.width, saved.height].allSatisfy({ $0.isFinite }) else { return nil }
        let center = NSPoint(x: saved.x + saved.width / 2, y: saved.y + saved.height / 2)
        let frame = clampedCollapsedFrame(centeredAt: center)
        return NSScreen.screens.contains(where: { $0.visibleFrame.intersects(frame) }) ? frame : nil
    }
    func snapshot() -> [String: Any] {
        let frame = panel?.frame ?? .zero
        let mouse = NSEvent.mouseLocation
        let window: [String: Any] = ["systemTitleVisible": false,
                                     "activationStyle": "nonactivating-panel",
                                     "canBecomeKey": panel?.canBecomeKey ?? true,
                                     "clickKeepsVisible": true,
                                     "resizable": hostView?.resizeEnabled ?? false,
                                     "nativeResizableStyleMask": panel?.styleMask.contains(.resizable) ?? false,
                                     "resizeImplementation": "custom-content-edge",
                                     "closable": panel?.styleMask.contains(.closable) ?? false,
                                     "movableByBackground": panel?.isMovableByWindowBackground ?? false,
                                     "resizeCursorZones": hostView?.resizeCursorZoneCount ?? 0,
                                     "resizeCursorTracking": "explicit-18pt-custom-functional-edge-single-cursor",
                                     "resizeCoordinateMapping": "flipped-hosting-view-to-screen-edges",
                                     "liveResizeCursorKind": liveCursorKind ?? NSNull(),
                                     "fallbackResizeCursorSuppressed": suppressingFallbackResizeCursor,
                                     "menuBarItemVisible": false,
                                     "customCloseButtonVisible": false,
                                     "pendingStepIconVisible": true,
                                     "pendingStepIconStyle": "bouncing-ellipsis",
                                     "questionStepStatus": "waiting_for_user",
                                     "questionStepIconStyle": "orange-questionmark-bubble-no-background",
                                     "questionStepAnimation": "subtle-breathe-and-lift",
                                     "pendingStepAnimationInterval": "stable-random-3.0-5.399s",
                                     "statusIconVerticalOffset": -4,
                                     "pendingDotsVerticalOffset": 0,
                                     "pendingDotsBaseOpacity": 0.50,
                                     "statusIconPalette": "original-vivid",
                                     "statusIconBackgroundVisible": false,
                                     "indeterminateStepProgressVisible": false,
                                     "footerVisible": false,
                                     "progressBarStyle": "thin-blue-animated",
                                     "progressAnimationOrigin": "leading-edge",
                                     "prototypeBadgeVisible": false,
                                     "mascotVisible": false,
                                     "headerBrandVisible": false,
                                     "headerContents": "emoji-title-counter",
                                     "planIconMultilineAlignment": "title-block-center",
                                     "counterAlignment": "plan-icon-center",
                                     "counterStyle": "rounded-outline",
                                     "palette": "codex-panel",
                                     "surfaceRGB": "#222224",
                                     "borderRGB": "#303032",
                                     "windowBorderStyle": "custom-rounded-1pt",
                                     "windowShadowVisible": false,
                                     "contentInset": PanelMetrics.inset,
                                     "headerTopInset": PanelMetrics.inset,
                                     "iconColumnWidth": PanelMetrics.iconColumn,
                                     "textColumnAlignment": "header-step-note",
                                     "stepTextRGB": "#B8B8BA",
                                     "planSelectorStyle": "hover-icon-strip",
                                     "planSelectorControlVisible": false,
                                     "planIconStyle": "emoji-hover-background",
                                     "planIconGlyphSize": PanelMetrics.planIconGlyph,
                                     "transitionPlanIconGlyphSize": PanelMetrics.planIconGlyph,
                                     "transitionPlanIconAnchor": "fixed-screen-center",
                                     "planEmojiPoolCount": planEmojiPool.count,
                                     "planOverflowBadge": "+N",
                                     "planSwitcherPlacement": "immediate-slide-from-active-icon",
                                     "planSwitcherRevealDelay": 0.0,
                                     "planTooltipStyle": "detached-nonactivating-title-tooltip",
                                     "planTooltipVisualStyle": "codex-dark-floating-card-rounded-8pt",
                                     "planTooltipTextSize": 11,
                                     "planTooltipMaxTextWidth": 220,
                                     "planTooltipOverflow": "outside-panel-screen-clamped-word-wrapped-two-lines",
                                     "planTooltipVisible": planTooltip.isVisible,
                                     "planTooltipTitle": planTooltip.title ?? NSNull(),
                                     "planTooltipFrame": ["x": planTooltip.frame.minX, "y": planTooltip.frame.minY,
                                                          "width": planTooltip.frame.width, "height": planTooltip.frame.height],
                                     "planHoverBackdrop": "shared-rounded-tray",
                                     "planHoverExitGrace": PanelMetrics.planHoverExitGrace,
                                     "planHoverExitPending": planHoverExitStartedAt != nil,
                                     "planHoverExitOrder": "tooltip-fade-icons-spring-tray-fade",
                                     "headerDividerVisible": true,
                                     "stepsSurfaceStartsAtDivider": true,
                                     "headerDividerHeight": PanelMetrics.headerDivider,
                                     "headerDividerRGB": "#303032",
                                     "agentIconStyle": "illustrated-assets",
                                     "agentPulseStyle": "subtle-opacity-contrast",
                                     "agentIconVerticalOffset": -2,
                                     "agentOverflow": "overlay-text-with-stronger-material-blur",
                                     "agentStackTrigger": "title-plus-icons-overflow-always-compacts",
                                     "agentStackMaximumWidth": 128,
                                     "agentStackStrideScale": 0.42,
                                     "agentBlurStrength": "regular-material-plus-surface-fade",
                                     "activeStepHighlightVisible": false,
                                     "progressBarWidth": "step-title",
                                     "agentPlacement": "after-step-title",
                                     "agentIconSpacing": 0,
                                     "completedAgentCheck": "green-no-background",
                                     "completedAgentCheckAnimation": "pop-then-periodic-rock",
                                     "completedPlanRetentionSeconds": retentionSeconds,
                                     "focusCollapseEnabled": focusCollapseEnabled,
                                     "hostLifecycle": "workspace-termination-observer-with-750ms-running-app-fallback",
                                     "workspaceTransitionBehavior": "preloaded-remote-icon-with-host-mirror",
                                     "workspaceWindowMotionPollingHz": 30,
                                     "spaceDepartureActive": spaceDepartureActive,
                                     "spaceArrivalPending": spaceArrivalPending,
                                     "awayFromHostSpace": awayFromHostSpace,
                                     "spaceOriginWasCollapsed": spaceOriginWasCollapsed ?? NSNull(),
                                     "spaceRoutingAvailable": spaceRouter != nil,
                                     "hostSpaceID": hostSpaceID ?? NSNull(),
                                     "spaceMirrorVisible": spaceMirrorVisible,
                                     "spaceMirrorPresentation": spaceMirrorState.collapsed ? "collapsed" : "expanded",
                                     "spaceMirrorFrame": spaceMirrorPanel.map {
                                        ["x": $0.frame.minX, "y": $0.frame.minY,
                                         "width": $0.frame.width, "height": $0.frame.height]
                                     } ?? NSNull(),
                                     "spaceMainAssignedSpaces": panel.flatMap { panel in
                                        spaceRouter?.spaces(for: panel.windowNumber)
                                     } ?? [],
                                     "spaceMirrorAssignedSpaces": spaceMirrorPanel.flatMap { mirror in
                                        spaceRouter?.spaces(for: mirror.windowNumber)
                                     } ?? [],
                                     "spaceRemoteIconVisible": spaceRemoteIconVisible,
                                     "spaceRemoteIconFrame": spaceRemoteIconPanel.map {
                                        ["x": $0.frame.minX, "y": $0.frame.minY,
                                         "width": $0.frame.width, "height": $0.frame.height]
                                     } ?? NSNull(),
                                     "spaceRemoteIconAssignedSpaces": spaceRemoteIconPanel.flatMap { remote in
                                        spaceRouter?.spaces(for: remote.windowNumber)
                                     } ?? [],
                                     "hostMinimizeDetection": "window-server-two-frame-proportional-shrink",
                                     "lastHostMinimizeTrigger": lastHostMinimizeTrigger ?? NSNull(),
                                     "hostMinimizingActive": hostMinimizingActive,
                                     "hostWindowMinimized": hostWindowMinimized,
                                     "hostWindowObservationInitialized": hostWindowObservationInitialized,
                                     "hostWindowObservation": lastHostWindowObservation.map {
                                        ["id": $0.id, "x": $0.frame.minX, "y": $0.frame.minY,
                                         "width": $0.frame.width, "height": $0.frame.height]
                                     } ?? NSNull(),
                                     "lastEarlyPresentationSignal": lastEarlyPresentationSignal ?? NSNull(),
                                     "lastEarlyPresentationSignalAt": lastEarlyPresentationSignalAt.map { ISO8601DateFormatter().string(from: $0) } ?? NSNull(),
                                     "presentation": collapsingToIcon ? "collapsing" : (store.collapsed ? "collapsed" : "expanded"),
                                     "presentationTransitioning": applyingPresentationFrame,
                                     "transitionContent": store.collapsed ? "collapsed-icon" :
                                        (store.transitionIconOnly ? "plan-icon-only" : "full-content"),
                                     "alpha": panel?.alphaValue ?? 0,
                                     "collapsedHovered": store.collapsedHovered,
                                     "collapsedExpandDelay": collapsedExpandDelay,
                                     "collapsedBorder": "1pt-white-17pct",
                                     "collapsedOpacity": 0.82,
                                     "collapseAnimation": "window-morphs-around-stationary-plan-icon",
                                     "presentationAnimationDriver": "common-runloop-direct-window-frames-60fps",
                                     "presentationTweenActive": presentationTween != nil,
                                     "collapseVisualSwap": "morphing-window-shell-with-icon-only-content",
                                     "collapsedDragSuppressesExpansion": true,
                                     "panelClickFocusesHost": true,
                                     "windowDragPreservesCurrentFocus": true,
                                     "hoverExpandedFrameContainsSourceIcon": true,
                                     "stepsSurfaceRGB": "#1F1F21",
                                     "collapsedPositionPersistence": "state.json:collapsedWindowFrame",
                                     "expandedPositionPersistence": "state.json:expandedWindowFrame",
                                     "unfocusedExpandedPositionPersistence": "state.json:unfocusedExpandedWindowFrame",
                                     "completionRetentionTrigger": "completion-time-only-never-focus",
                                     "completedPlanCheck": "centered-green-grow-with-dissolving-material-blur",
                                     "completedPlanLifecycle": "centered-check-to-deadline-countdown-ring",
                                     "completedPlanCountdown": "reverse-direction-shrinking-ring-matches-collapsed-border",
                                     "completedPlanHoverAction": "blurred-x-immediate-remove",
                                     "windowDragSurface": "all-content-except-resize-and-plan-switcher",
                                     "pendingStepAlignment": "reserved-column",
                                     "noteAnimation": "blur-fade-rise-on-insert-and-change",
                                     "noteTopSpacing": 3,
                                     "stepVerticalPadding": 3,
                                     "stepSpacing": 0,
                                     "framePersistence": "state.json",
                                     "x": frame.minX, "y": frame.minY,
                                     "mouseX": mouse.x, "mouseY": mouse.y,
                                     "width": frame.width, "height": frame.height,
                                     "minimumWidth": store.collapsed ? collapsedSize.width : expandedMinimumSize.width,
                                     "minimumHeight": store.collapsed ? collapsedSize.height : expandedMinimumSize.height]
        let plans: [[String: Any]] = store.plans.map {
            ["id": $0.id, "revision": $0.revision, "done": $0.done, "total": $0.steps.count,
             "icon": planEmoji($0)]
        }
        let activeRetentionFraction: Any = store.active.flatMap { plan in
            store.retentionDeadlines[plan.id].map {
                max(0, min(1, $0.timeIntervalSinceNow / max(0.1, retentionSeconds)))
            }
        } ?? NSNull()
        return ["pid": Int(getpid()), "selected": store.selected ?? NSNull(), "planCount": store.plans.count,
                "selectorVisible": false, "planSwitcherAvailable": store.plans.count > 1,
                "planSwitcherExpanded": store.planSwitcherExpanded,
                "hoveredPlanID": store.hoveredPlanID ?? NSNull(),
                "visible": panel?.isVisible ?? false,
                "frontmostBundle": NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "unknown",
                "eventCount": store.eventCount, "selectedRevision": store.active?.revision ?? 0,
                "activeStatus": store.active?.status ?? NSNull(),
                "activeRetentionFraction": activeRetentionFraction,
                "retentionArmedPlanIDs": Array(retentionStartedAt.keys).sorted(),
                "expandedWindowFrame": expandedFrame.map { ["x": $0.minX, "y": $0.minY, "width": $0.width, "height": $0.height] } ?? NSNull(),
                "unfocusedExpandedWindowFrame": unfocusedExpandedFrame.map { ["x": $0.minX, "y": $0.minY, "width": $0.width, "height": $0.height] } ?? NSNull(),
                "collapsedWindowFrame": collapsedFrame.map { ["x": $0.minX, "y": $0.minY, "width": $0.width, "height": $0.height] } ?? NSNull(),
                "plans": plans, "binding": "manual-selector", "hostBundle": hostBundle,
                "dismissed": dismissed, "window": window]
    }
    func journal(_ event: String) {
        guard dataURL != nil else { return }
        var row = snapshot(); row["event"] = event; row["at"] = ISO8601DateFormatter().string(from: Date())
        guard var bytes = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) else { return }
        bytes.append(10)
        let path = dataURL.appendingPathComponent("events.jsonl")
        if !FileManager.default.fileExists(atPath: path.path) { FileManager.default.createFile(atPath: path.path, contents: nil) }
        if let file = try? FileHandle(forWritingTo: path) { defer { try? file.close() }; _ = try? file.seekToEnd(); try? file.write(contentsOf: bytes) }
    }
    func handle(_ command: Command) -> [String: Any] {
        do {
            switch command.action {
            case "event":
                guard let plan = command.plan, plan.source != nil else { throw NSError(domain: "Missing event plan/source", code: 3) }
                let oldPlans = store.plans, oldSelected = store.selected, oldWatermarks = store.creationWatermarks, oldCount = store.eventCount
                let changed = store.changed; store.changed = nil
                defer { store.changed = changed }
                do {
                    try store.upsert(plan, event: true, selectOnCreate: command.selectOnCreate ?? false)
                    try persist() // ACK only after the event AND selection are safely saved.
                } catch {
                    store.plans = oldPlans; store.selected = oldSelected; store.creationWatermarks = oldWatermarks; store.eventCount = oldCount
                    throw error
                }
                scheduleExpiry(); syncPresentation(); journal("event_applied")
            case "upsert":
                guard let plan = command.plan else { throw NSError(domain: "Missing plan", code: 3) }
                try store.upsert(plan)
            case "select":
                guard let id = command.id, store.plans.contains(where: { $0.id == id }) else { throw NSError(domain: "Unknown plan", code: 4) }
                store.select(id)
            case "remove":
                guard let id = command.id, store.plans.contains(where: { $0.id == id }) else { throw NSError(domain: "Unknown plan", code: 4) }
                removePlan(id, event: "plan_removed")
            case "set_focus_collapse":
                guard let enabled = command.enabled else { throw NSError(domain: "Missing enabled preference", code: 13) }
                focusCollapseEnabled = enabled
                if enabled {
                    retentionStartedAt = retentionStartedAt.filter { id, _ in store.plans.contains(where: { $0.id == id }) }
                } else {
                    retentionStartedAt.removeAll()
                    expandedFromIconSource = nil
                    expandedMovedBeyondSource = false
                }
                try persist()
                scheduleExpiry()
                syncPresentation()
                journal("focus_collapse_preference")
            case "set_frame":
                guard let x = command.x, let y = command.y, let width = command.width, let height = command.height,
                      [x, y, width, height].allSatisfy({ $0.isFinite }),
                      (280...4000).contains(width), (240...4000).contains(height) else {
                    throw NSError(domain: "Invalid window frame", code: 8)
                }
                panel.setFrame(NSRect(x: x, y: y, width: width, height: height), display: false)
                expandedFrame = panel.frame
                try persist()
            case "cursor_probe":
                guard let x = command.x, let y = command.y else { throw NSError(domain: "Missing cursor probe point", code: 9) }
                return ["ok": true, "kind": hostView.resizeCursorKind(at: NSPoint(x: x, y: y)) ?? "arrow", "state": snapshot()]
            case "completion_click_probe":
                guard let x = command.x, let y = command.y else { throw NSError(domain: "Missing completion probe point", code: 9) }
                let point = NSPoint(x: panel.frame.minX + x, y: panel.frame.minY + y)
                let removed = activePlanIconContains(point)
                    && store.selected.map(removeCompletedPlanIfReady) == true
                return ["ok": true, "removed": removed, "state": snapshot()]
            case "workspace_transition_probe":
                if command.name == "arriving" {
                    noteSpaceArrival()
                } else if command.name == "departure-completed" {
                    finishSpaceDeparture()
                } else if command.name == "return-completed" {
                    restoreHostSpacePresentation()
                } else if command.name == "focus-leaving" {
                    beginEarlyPresentationTransition(source: "host-deactivated")
                } else {
                    beginSpaceDeparture()
                }
                return ["ok": true, "state": snapshot()]
            case "status": break
            case "snapshot":
                guard let name = command.name, name.range(of: "^[a-zA-Z0-9_-]{1,60}$", options: .regularExpression) != nil else { throw NSError(domain: "Invalid snapshot name", code: 5) }
                hostView.layoutSubtreeIfNeeded()
                guard let bitmap = hostView.bitmapImageRepForCachingDisplay(in: hostView.bounds) else { throw NSError(domain: "Snapshot unavailable", code: 6) }
                hostView.cacheDisplay(in: hostView.bounds, to: bitmap)
                try bitmap.representation(using: .png, properties: [:])?.write(to: dataURL.appendingPathComponent(name + ".png"))
                if planTooltip.isVisible {
                    try planTooltip.writeSnapshot(to: dataURL.appendingPathComponent(name + "-tooltip.png"))
                }
            case "quit": DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { NSApp.terminate(nil) }
            default: throw NSError(domain: "Unknown action", code: 7)
            }
            return ["ok": true, "state": snapshot()]
        } catch { return ["ok": false, "error": String(describing: error), "state": snapshot()] }
    }
    func startSocket() throws {
        var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let bytes = Array(socketPath.utf8) + [0]
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw NSError(domain: "Socket path too long", code: 8) }
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
        // Recover only our user's stale Unix socket; never unlink a live listener or ordinary file.
        if let attrs = try? FileManager.default.attributesOfItem(atPath: socketPath) {
            guard attrs[.type] as? FileAttributeType == .typeSocket,
                  (attrs[.ownerAccountID] as? NSNumber)?.uint32Value == getuid() else {
                throw NSError(domain: "Unsafe existing socket path", code: 10)
            }
            let probe = socket(AF_UNIX, SOCK_STREAM, 0)
            guard probe >= 0 else { throw NSError(domain: "socket probe", code: Int(errno)) }
            let connected = withUnsafePointer(to: &address) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(probe, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
            }
            let reason = errno; Darwin.close(probe)
            guard connected != 0 && [ECONNREFUSED, ENOENT].contains(reason) else {
                throw NSError(domain: "Companion already running or socket unavailable", code: 11)
            }
            if reason == ECONNREFUSED { unlink(socketPath) }
        }
        listener = socket(AF_UNIX, SOCK_STREAM, 0)
        guard listener >= 0 else { throw NSError(domain: "socket", code: Int(errno)) }
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard result == 0 else { Darwin.close(listener); listener = -1; throw NSError(domain: "bind (existing instance?)", code: Int(errno)) }
        chmod(socketPath, 0o600)
        guard listen(listener, 8) == 0 else { throw NSError(domain: "listen", code: Int(errno)) }
        let server = listener
        DispatchQueue.global(qos: .utility).async { [weak self] in
            while true {
                let client = accept(server, nil, nil)
                if client < 0 { break }
                var one: Int32 = 1; setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout.size(ofValue: one)))
                var timeout = timeval(tv_sec: 2, tv_usec: 0)
                setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout)))
                setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout)))
                var payload = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
                let deadline = DispatchTime.now().uptimeNanoseconds + 2_000_000_000
                while payload.count < 65536 && DispatchTime.now().uptimeNanoseconds < deadline {
                    let count = Darwin.read(client, &buffer, buffer.count)
                    if count <= 0 { break }; payload.append(contentsOf: buffer.prefix(count))
                    if payload.contains(10) { break }
                }
                let line = payload.prefix { $0 != 10 }
                let command = payload.contains(10) && payload.count < 65536 ? try? JSONDecoder().decode(Command.self, from: line) : nil
                DispatchQueue.main.async {
                    let response = command.map { self?.handle($0) ?? ["ok": false] } ?? ["ok": false, "error": "Invalid JSON command"]
                    var data = (try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])) ?? Data()
                    data.append(10)
                    let responseBytes = data
                    DispatchQueue.global(qos: .utility).async {
                        responseBytes.withUnsafeBytes { raw in
                            var sent = 0
                            while sent < raw.count { let count = Darwin.write(client, raw.baseAddress!.advanced(by: sent), raw.count - sent); if count <= 0 { break }; sent += count }
                        }
                        Darwin.close(client)
                    }
                }
            }
        }
    }
    func applicationWillTerminate(_ notification: Notification) {
        journal("stopped")
        for observer in observers { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        if let localEventMonitor { NSEvent.removeMonitor(localEventMonitor) }
        if listener >= 0 { Darwin.close(listener); unlink(socketPath) }
        if instanceLock >= 0 { Darwin.close(instanceLock) }
    }
}
let delegate = Delegate()
let app = NSApplication.shared
app.delegate = delegate
app.run()
