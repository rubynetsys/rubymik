import SoftwareUpdateCard from '../components/SoftwareUpdateCard';

export default function Updates() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-fg-strong">Updates</h1>
        <p className="mt-1 text-sm text-fg-dim">Check whether a newer RubyMIK is available. RubyMIK never updates itself — updating is always your <code className="rounded bg-app px-1 py-0.5 font-mono text-xs">docker compose pull &amp;&amp; up -d</code>.</p>
      </header>
      <SoftwareUpdateCard />
    </div>
  );
}
