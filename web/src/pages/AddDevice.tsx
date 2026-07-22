import { Link } from 'react-router-dom';
import { ArrowRight, HardDriveDownload, PlusCircle, Wand2 } from 'lucide-react';

/**
 * Unified "Add device" entry (P27). One menu item, one first question — is this a
 * MikroTik that's already set up, or a brand-new/factory-fresh one? — then it hands
 * off to the existing onboard (`/add-device/existing`) or provision
 * (`/add-device/new`) flows. The old `/onboard` and `/provision` routes redirect here.
 */
export default function AddDevice() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-fg-strong">
          <PlusCircle className="h-6 w-6 text-accent" /> Add a device
        </h1>
        <p className="mt-1 text-sm text-fg-dim">First things first — is this MikroTik already configured, or brand new?</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <Choice
          to="/add-device/existing"
          icon={Wand2}
          title="Existing MikroTik"
          tag="already configured"
          body="It's already on the network and has an IP and login. RubyMIK connects to it and starts monitoring — no changes are made to its config."
        />
        <Choice
          to="/add-device/new"
          icon={HardDriveDownload}
          title="New / factory-fresh MikroTik"
          tag="blank router"
          body="It's out of the box (or reset). RubyMIK builds a complete baseline — WAN, LAN, DHCP, firewall — that you review before anything is applied."
        />
      </div>

      <p className="text-xs text-fg-faint">
        Not sure? If you can already reach the router's admin page, choose “Existing”. If it's still on the default 192.168.88.1 with no setup, choose “New”.
      </p>
    </div>
  );
}

function Choice({ to, icon: Icon, title, tag, body }: {
  to: string; icon: React.ComponentType<{ className?: string }>; title: string; tag: string; body: string;
}) {
  return (
    <Link to={to}
      className="group flex flex-col rounded-2xl border border-border bg-surface p-5 shadow-sm transition hover:border-accent-border hover:shadow-md">
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-subtle">
        <Icon className="h-6 w-6 text-accent" />
      </div>
      <div className="mt-3 flex items-center gap-2">
        <h2 className="text-base font-bold text-fg-strong">{title}</h2>
        <span className="rounded-full bg-app px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg-muted">{tag}</span>
      </div>
      <p className="mt-1.5 flex-1 text-sm text-fg-dim">{body}</p>
      <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-accent-text">
        Continue <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}
