import Cocoa
import UserNotifications

// Usage:
//   AssistNotify <title> <message> <url>   show a notification
//   AssistNotify                           launched by clicking a notification
//
// Clicking the notification opens <url> instead of Script Editor.

let args = CommandLine.arguments
let isStatusCheck = args.count > 1 && args[1] == "--status"
let title = args.count > 1 && !isStatusCheck ? args[1] : ""
let message = args.count > 2 ? args[2] : ""
let url = args.count > 3 ? args[3] : ""
let hasPayload = !title.isEmpty

final class AppDelegate: NSObject, UNUserNotificationCenterDelegate {
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if let raw = response.notification.request.content.userInfo["url"] as? String,
           !raw.isEmpty,
           let target = URL(string: raw) {
            NSWorkspace.shared.open(target)
        }
        completionHandler()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            NSApp.terminate(nil)
        }
    }
}

let delegate = AppDelegate()
let center = UNUserNotificationCenter.current()
center.delegate = delegate

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

if isStatusCheck {
    center.getNotificationSettings { settings in
        let status: String
        switch settings.authorizationStatus {
        case .authorized: status = "authorized"
        case .denied: status = "denied"
        case .provisional: status = "provisional"
        case .ephemeral: status = "ephemeral"
        case .notDetermined: status = "notDetermined"
        @unknown default: status = "unknown"
        }
        print("bundle=\(Bundle.main.bundleIdentifier ?? "nil") status=\(status)")
        exit(0)
    }
} else if hasPayload {
    center.requestAuthorization(options: [.alert, .sound]) { granted, error in
        guard granted else {
            let reason = error.map { "\($0)" } ?? "denied"
            FileHandle.standardError.write(
                "notifications unavailable: \(reason)\n".data(using: .utf8)!
            )
            DispatchQueue.main.async { NSApp.terminate(nil) }
            return
        }

        let content = UNMutableNotificationContent()
        content.title = title
        content.body = message
        content.sound = .default
        if !url.isEmpty {
            content.userInfo = ["url": url]
        }

        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil
        )
        center.add(request) { addError in
            if let addError {
                FileHandle.standardError.write(
                    "failed to add notification: \(addError)\n".data(using: .utf8)!
                )
            }
            // Keep the process alive briefly so an immediate click is handled.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                NSApp.terminate(nil)
            }
        }
    }
} else {
    // Started by clicking a notification: wait for the system to deliver it.
    DispatchQueue.main.asyncAfter(deadline: .now() + 4.0) {
        NSApp.terminate(nil)
    }
}

app.run()
