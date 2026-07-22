import NotificationChannels from '../components/NotificationChannels';

export default function Notifications() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-fg-strong">Notifications</h1>
        <p className="mt-1 text-sm text-fg-dim">Where RubyMIK sends alerts — email (SMTP), webhook, Telegram, WhatsApp. Secrets are stored encrypted and never shown again.</p>
      </header>
      <NotificationChannels />
    </div>
  );
}
