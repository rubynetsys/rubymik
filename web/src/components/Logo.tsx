interface LogoProps {
  /** Renders on dark backgrounds (sidebar / auth pages) when true. */
  dark?: boolean;
  size?: 'md' | 'lg';
}

export function RubyDiamond({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="ruby-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#E91E63" />
          <stop offset="1" stopColor="#C41E56" />
        </linearGradient>
      </defs>
      <path d="M7 3h10l4.5 6L12 21.5 2.5 9 7 3z" fill="url(#ruby-g)" />
      <path
        d="M2.5 9h19M7 3l5 6 5-6M12 9v12.5"
        stroke="#fff"
        strokeOpacity=".38"
        strokeWidth="1"
        fill="none"
      />
    </svg>
  );
}

export default function Logo({ dark, size = 'md' }: LogoProps) {
  const iconCls = size === 'lg' ? 'h-10 w-10' : 'h-7 w-7';
  const nameCls = size === 'lg' ? 'text-2xl' : 'text-lg';
  return (
    <div className="flex items-center gap-2.5">
      <RubyDiamond className={iconCls} />
      <div className="leading-tight">
        <div className={`${nameCls} font-bold tracking-tight ${dark ? 'text-white' : 'text-zinc-900'}`}>
          Ruby<span className="text-ruby-500">MIK</span>
        </div>
        <div className={`text-[10px] font-medium uppercase tracking-widest ${dark ? 'text-zinc-500' : 'text-zinc-400'}`}>
          by RubyNet
        </div>
      </div>
    </div>
  );
}
