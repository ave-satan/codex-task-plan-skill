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
    "🫠","🫨","🥴","🤪","🫥","🫣","🫡","🤠","🥸","🤡",
    "👹","👺","👻","👽","👾","🤖","💩","😈","👿","☠️",
    "💀","🤯","🤤","🤓","🧐","🥶","🥵","🤢","🤮","🤧",
    "🤑","🤬","😵‍💫","😵","🫢","🤭","🥳","🥹","😶‍🌫️","😬",
    "🐙","🦑","🪼","🦀","🦞","🦐","🐡","🦈","🐊","🦎",
    "🐍","🐲","🐉","🦖","🦕","🦧","🦍","🦥","🦦","🦨",
    "🦡","🦔","🐀","🐿️","🦇","🦉","🦤","🦚","🦩","🪿",
    "🐓","🦃","🦆","🐸","🐌","🪲","🪳","🕷️","🦂","🦗",
    "🐛","🐝","🪰","🦟","🪱","🐗","🐐","🦙","🦒","🦛",
    "🍄","🌵","🪴","🧌","🗿","🎃","🧠","🫀","🫁","🦷",
    "🦴","👁️","👀","👅","🦾","🦿","🧿","🔮","🪩","🧨",
    "🧯","🪤","🧪","🧫","🧬","🩻","🛸","🛰️","🚽","🪠",
    "🧻","🛒","🧹","🪣","🪅","🎪","🎭","🃏","🧸","🪆",
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
    static let columnGap: CGFloat = 8
    static let headerBottom: CGFloat = 8
    static let headerDivider: CGFloat = 0.5
    static let planHoverExitGrace: TimeInterval = 0.18
}

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
struct Saved: Codable {
    var plans: [Plan]
    var selected: String?
    var creationWatermarks: [String: Int]?
    var windowFrame: WindowFrame? = nil
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
}

// All state transitions run on the AppKit main queue, including IPC updates.
final class Store: ObservableObject {
    @Published var plans: [Plan] = []
    @Published var selected: String?
    @Published var eventCount = 0
    @Published var planSwitcherExpanded = false
    @Published var hoveredPlanID: String?
    var creationWatermarks: [String: Int] = [:]
    var changed: (() -> Void)?
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
            if event && plan.revision <= plans[index].revision { return } // Durable replay ACK.
            guard plan.revision > plans[index].revision else { throw NSError(domain: "Stale revision", code: 2) }
            plans[index] = plan // Updates/completion NEVER select a plan or activate a window.
        } else {
            plans.append(plan)
            if !event { selected = plan.id }
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

final class WindowDragView: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
}

struct WindowDragArea: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { WindowDragView() }
    func updateNSView(_ nsView: NSView, context: Context) {}
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
    var plan: Plan
    var size: CGFloat = 30
    var highlighted = false

    var body: some View {
        ZStack {
            Circle().fill(highlighted ? Color.white.opacity(0.055) : .clear)
            Text(planEmoji(plan))
                .font(.system(size: min(PanelMetrics.planIconGlyph, size * 0.75)))
                .multilineTextAlignment(.center)
                .offset(y: 0.5)
        }
            .frame(width: size, height: size)
            .contentShape(Circle())
            .accessibilityLabel(plan.title)
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
                        .frame(width: PanelMetrics.iconColumn + 8 + (store.planSwitcherExpanded ? CGFloat(otherPlans.count) * 28 : 0),
                               height: 28)
                        .offset(x: -4)
                        .transition(.scale(scale: 0.72, anchor: .leading).combined(with: .opacity))
                        .animation(.spring(response: 0.26, dampingFraction: 0.86), value: store.planSwitcherExpanded)
                        .zIndex(0)
                }
                HStack(spacing: 4) {
                    PlanEmojiCircle(plan: active, size: PanelMetrics.iconColumn,
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
                                PlanEmojiCircle(plan: plan, size: PanelMetrics.iconColumn,
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
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
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
                    .padding(.top, 3)
                }
                .padding(.horizontal, PanelMetrics.inset)
                .padding(.top, PanelMetrics.inset)
                .padding(.bottom, PanelMetrics.headerBottom)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(WindowDragArea())
                Rectangle()
                    .fill(CodexPalette.border)
                    .frame(height: PanelMetrics.headerDivider)
                    .padding(.horizontal, PanelMetrics.inset)
                    .padding(.bottom, 4)
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(plan.steps) { step in
                                StepRow(step: step).id(step.id)
                            }
                        }
                        .padding(.horizontal, PanelMetrics.inset)
                        .padding(.bottom, PanelMetrics.inset)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: .infinity)
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

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        window?.acceptsMouseMovedEvents = true
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        if resizeCursorKind(at: point) != nil { return self }
        return super.hitTest(point)
    }

    func resizeCursorKind(at point: NSPoint) -> String? {
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
        let minSize = window.minSize
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
    var hostView: PanelHostingView<PanelView>!
    var observers: [NSObjectProtocol] = []
    var localEventMonitor: Any?
    var dismissed = false
    var listener: Int32 = -1
    var instanceLock: Int32 = -1
    var socketPath = ""
    var dataURL: URL!
    var restoredFrame: WindowFrame?
    let hostBundle = ProcessInfo.processInfo.environment["PLAN_COMPANION_HOST"] ?? "com.openai.codex"
    var lastVisibility: Bool?
    var expiryTimer: Timer?
    var cursorTimer: Timer?
    let planTooltip = PlanTooltipPanel()
    var liveCursorKind: String?
    var suppressingFallbackResizeCursor = false
    var planHoverExitStartedAt: Date?
    let retentionSeconds = max(0.1, Double(ProcessInfo.processInfo.environment["PLAN_COMPANION_RETENTION_SECONDS"] ?? "") ?? 30)

    func terminalDate(_ plan: Plan) -> Date? {
        guard ["completed", "cancelled"].contains(plan.status ?? "") else { return nil }
        return parseISODate(plan.completedAt)
    }

    @discardableResult func pruneExpiredPlans(at now: Date = Date()) -> Bool {
        let count = store.plans.count
        store.plans.removeAll { plan in
            guard let terminal = terminalDate(plan) else { return false }
            return now.timeIntervalSince(terminal) >= retentionSeconds
        }
        guard store.plans.count != count else { return false }
        if let selected = store.selected, !store.plans.contains(where: { $0.id == selected }) {
            store.selected = store.plans.last?.id
        }
        return true
    }

    func scheduleExpiry() {
        expiryTimer?.invalidate(); expiryTimer = nil
        let now = Date()
        let next = store.plans.compactMap(terminalDate).map { $0.addingTimeInterval(retentionSeconds) }
            .filter { $0 > now }.min()
        guard let next else { return }
        expiryTimer = Timer.scheduledTimer(withTimeInterval: max(0.05, next.timeIntervalSince(now)), repeats: false) { [weak self] _ in
            guard let self else { return }
            let removed = self.pruneExpiredPlans()
            if removed { try? self.persist(); self.syncVisibility(); self.journal("plans_expired") }
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
            }
            try startSocket()
        } catch { fputs("Startup failed: \(error)\n", stderr); NSApp.terminate(nil); return }
        NSApp.setActivationPolicy(.accessory)
        panel = PlanPanel(contentRect: NSRect(x: 0, y: 0, width: 420, height: 430),
                          styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "Task Plan Companion"
        panel.delegate = self; panel.isReleasedWhenClosed = false
        panel.level = .floating; panel.hidesOnDeactivate = false; panel.becomesKeyOnlyIfNeeded = true
        panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        panel.titleVisibility = .hidden; panel.titlebarAppearsTransparent = true
        panel.standardWindowButton(.closeButton)?.isHidden = true
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true
        panel.isMovableByWindowBackground = true
        panel.minSize = NSSize(width: 280, height: 240)
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.isOpaque = false
        panel.hasShadow = false
        panel.backgroundColor = .clear
        hostView = PanelHostingView(rootView: PanelView(store: store))
        panel.contentView = hostView
        panel.enableCursorRects()
        cursorTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
            self?.syncLiveResizeCursor()
            self?.syncPlanSwitcherHover()
        }
        cursorTimer?.tolerance = 1.0 / 120
        localEventMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown]) { [weak self] event in
            guard let self else { return event }
            if self.panel.frame.contains(NSEvent.mouseLocation) {
                self.restoreHostFocusAfterPointerRelease()
            }
            guard self.store.planSwitcherExpanded,
                  let hovered = self.store.hoveredPlanID,
                  hovered != self.store.selected else { return event }
            self.store.select(hovered)
            return nil
        }
        store.changed = { [weak self] in self?.stateChanged() }
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.didActivateApplicationNotification, NSWorkspace.activeSpaceDidChangeNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.syncVisibility() })
        }
        if let frame = validRestoredFrame() {
            panel.setFrame(frame, display: false)
        } else if let screen = NSScreen.main {
            panel.setFrameTopLeftPoint(NSPoint(x: screen.visibleFrame.maxX - 430, y: screen.visibleFrame.maxY - 65))
        }
        if pruneExpiredPlans() { try? persist() }
        scheduleExpiry()
        syncVisibility(); journal("started")
        print("READY \(socketPath)"); fflush(stdout)
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { dismissed = true; panel.orderOut(nil); journal("dismissed"); return false }
    func windowDidMove(_ notification: Notification) { try? persist() }
    func windowDidResize(_ notification: Notification) { try? persist() }
    func liveResizeCursorKind(at point: NSPoint) -> String? {
        guard panel?.isVisible == true else { return nil }
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
        let point = NSEvent.mouseLocation
        let kind = liveResizeCursorKind(at: point)
        if let kind {
            let entering = liveCursorKind == nil && !suppressingFallbackResizeCursor
            suppressingFallbackResizeCursor = false
            liveCursorKind = kind
            if entering {
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
            if entering {
                NSApp.activate(ignoringOtherApps: true)
                panel.makeKeyAndOrderFront(nil)
            }
            NSCursor.arrow.set()
        } else if liveCursorKind != nil || suppressingFallbackResizeCursor {
            liveCursorKind = nil
            suppressingFallbackResizeCursor = false
            NSCursor.arrow.set()
            NSRunningApplication.runningApplications(withBundleIdentifier: hostBundle).first?.activate()
        }
    }
    func syncPlanSwitcherHover() {
        guard panel?.isVisible == true, let active = store.active, store.plans.count > 1 else {
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
            if !store.planSwitcherExpanded {
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
                NSApp.deactivate()
                NSRunningApplication.runningApplications(withBundleIdentifier: self.hostBundle).first?.activate()
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
        syncVisibility(); journal("state_changed")
    }
    func persist() throws {
        let frame = panel?.frame
        let savedFrame = frame.map { WindowFrame(x: $0.minX, y: $0.minY, width: $0.width, height: $0.height) }
        try JSONEncoder().encode(Saved(plans: store.plans, selected: store.selected,
                                      creationWatermarks: store.creationWatermarks, windowFrame: savedFrame ?? restoredFrame))
            .write(to: dataURL.appendingPathComponent("state.json"), options: .atomic)
    }
    func validRestoredFrame() -> NSRect? {
        guard let saved = restoredFrame,
              [saved.x, saved.y, saved.width, saved.height].allSatisfy({ $0.isFinite }),
              saved.width >= panel.minSize.width, saved.height >= panel.minSize.height else { return nil }
        let frame = NSRect(x: saved.x, y: saved.y, width: saved.width, height: saved.height)
        return NSScreen.screens.contains(where: { $0.visibleFrame.intersects(frame) }) ? frame : nil
    }
    func syncVisibility() {
        guard panel != nil else { return }
        let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        let companion = Bundle.main.bundleIdentifier
        let ownsCompanionFocus = front == companion
        let visible = (front == hostBundle || ownsCompanionFocus) && store.active != nil && !dismissed
        if visible { panel.orderFrontRegardless() } else { panel.orderOut(nil) }
        if visible != lastVisibility { lastVisibility = visible; journal("visibility") }
    }
    func snapshot() -> [String: Any] {
        let frame = panel?.frame ?? .zero
        let mouse = NSEvent.mouseLocation
        let window: [String: Any] = ["systemTitleVisible": false,
                                     "activationStyle": "nonactivating-panel",
                                     "canBecomeKey": panel?.canBecomeKey ?? true,
                                     "clickKeepsVisible": true,
                                     "resizable": true,
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
                                     "counterAlignment": "title-baseline",
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
                                     "pendingStepAlignment": "reserved-column",
                                     "noteAnimation": "blur-fade-rise-on-insert-and-change",
                                     "noteTopSpacing": 3,
                                     "stepVerticalPadding": 3,
                                     "stepSpacing": 0,
                                     "framePersistence": "state.json",
                                     "x": frame.minX, "y": frame.minY,
                                     "mouseX": mouse.x, "mouseY": mouse.y,
                                     "width": frame.width, "height": frame.height,
                                     "minimumWidth": panel?.minSize.width ?? 0,
                                     "minimumHeight": panel?.minSize.height ?? 0]
        let plans: [[String: Any]] = store.plans.map {
            ["id": $0.id, "revision": $0.revision, "done": $0.done, "total": $0.steps.count,
             "icon": planEmoji($0)]
        }
        return ["pid": Int(getpid()), "selected": store.selected ?? NSNull(), "planCount": store.plans.count,
                "selectorVisible": false, "planSwitcherAvailable": store.plans.count > 1,
                "planSwitcherExpanded": store.planSwitcherExpanded,
                "hoveredPlanID": store.hoveredPlanID ?? NSNull(),
                "visible": panel?.isVisible ?? false,
                "frontmostBundle": NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "unknown",
                "eventCount": store.eventCount, "selectedRevision": store.active?.revision ?? 0,
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
                scheduleExpiry(); syncVisibility(); journal("event_applied")
            case "upsert":
                guard let plan = command.plan else { throw NSError(domain: "Missing plan", code: 3) }
                try store.upsert(plan)
            case "select":
                guard let id = command.id, store.plans.contains(where: { $0.id == id }) else { throw NSError(domain: "Unknown plan", code: 4) }
                store.select(id)
            case "remove":
                guard let id = command.id, store.plans.contains(where: { $0.id == id }) else { throw NSError(domain: "Unknown plan", code: 4) }
                store.plans.removeAll { $0.id == id }
                if store.selected == id { store.selected = store.plans.last?.id }
                stateChanged()
            case "set_frame":
                guard let x = command.x, let y = command.y, let width = command.width, let height = command.height,
                      [x, y, width, height].allSatisfy({ $0.isFinite }),
                      (280...4000).contains(width), (240...4000).contains(height) else {
                    throw NSError(domain: "Invalid window frame", code: 8)
                }
                panel.setFrame(NSRect(x: x, y: y, width: width, height: height), display: false)
                try persist()
            case "cursor_probe":
                guard let x = command.x, let y = command.y else { throw NSError(domain: "Missing cursor probe point", code: 9) }
                return ["ok": true, "kind": hostView.resizeCursorKind(at: NSPoint(x: x, y: y)) ?? "arrow", "state": snapshot()]
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
        if listener >= 0 { Darwin.close(listener); unlink(socketPath) }
        if instanceLock >= 0 { Darwin.close(instanceLock) }
    }
}
let delegate = Delegate()
let app = NSApplication.shared
app.delegate = delegate
app.run()
