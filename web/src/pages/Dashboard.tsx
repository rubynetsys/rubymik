import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Router as RouterIcon } from 'lucide-react';
import { api } from '../api';
import type { Device } from '../types';

export default function Dashboard() {
  const [devices, setDevices] = useState<Device[] | null>(null);

  useEffect(() => {
    api.get<Device[]>('/api/devices').then(setDevices).catch(() => setDevices([]));
  }, []);

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-bold tracking-tight text-zinc-900">Dashboard</h1>
      <p className="mt-1 text-sm text-zinc-500">Your network at a glance.</p>

      <div className="mt-8 rounded-2xl border border-zinc-200 bg-white p-12 shadow-sm">
        <div className="mx-auto flex max-w-md flex-col items-center text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-ruby-50">
            <RouterIcon className="h-7 w-7 text-ruby-600" />
          </div>
          <h2 className="mt-4 text-lg font-semibold text-zinc-900">
            {devices && devices.length > 0 ? 'Monitoring is on its way' : 'No devices yet'}
          </h2>
          <p className="mt-1.5 text-sm text-zinc-500">
            {devices && devices.length > 0
              ? `${devices.length} device${devices.length === 1 ? '' : 's'} connected. Live monitoring lands in the next release — for now, run connection tests from the Devices page.`
              : 'Add your first MikroTik device to start monitoring. All you need is its IP address and a RouterOS login.'}
          </p>
          <Link
            to="/devices"
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-ruby-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-ruby-500"
          >
            <Plus className="h-4 w-4" />
            {devices && devices.length > 0 ? 'Manage devices' : 'Add your first device'}
          </Link>
        </div>
      </div>
    </div>
  );
}
