import Link from "next/link";
import { SectionHeader } from "./HowItWorks";

export function MiningPreview() {
  return (
    <section className="relative py-28 px-6">
      <div className="max-w-5xl mx-auto">
        <div className="grid md:grid-cols-2 gap-12 items-center">
          <div>
            <SectionHeader
              kicker="Mine it"
              title="Your GPU is the rig."
              sub="The reference GPU miner is open source and cross-platform via wgpu — Metal on macOS, Vulkan on Linux/Windows, DX12 on Windows. No CUDA, no driver install. Plug in any modern GPU and the same WGSL shaders run on it. CPU fallback ships too."
            />
            <div className="mt-9 flex flex-col sm:flex-row gap-3">
              <Link
                href="/download"
                className="inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-full bg-[var(--color-rose)] text-[var(--color-bg)] text-[15px] font-bold hover:bg-[var(--color-rose-bright)] transition-all glow-rose-soft"
              >
                GPU miner setup →
              </Link>
              <Link
                href="/mine"
                className="inline-flex items-center justify-center gap-2 px-5 py-3.5 rounded-full border border-[var(--color-border-bright)] text-[15px] font-medium text-[var(--color-fg-soft)] hover:bg-white/[0.03]"
              >
                Try in browser
              </Link>
            </div>

            <div className="mt-10 grid grid-cols-2 gap-3">
              <MiniStat label="GPU backend" value="Metal · Vulkan · DX12" />
              <MiniStat label="Avg solve time" value="~80 ms" />
              <MiniStat label="Memory-bound" value="Yes" accent />
              <MiniStat label="ASIC resistant" value="Yes" accent />
            </div>
          </div>

          {/* Terminal preview */}
          <div className="relative">
            <div className="absolute -inset-6 rounded-3xl opacity-30 blur-2xl pointer-events-none"
              style={{ background: "radial-gradient(circle, rgba(232,90,141,0.4), transparent 65%)" }} />
            <div className="relative rounded-2xl border border-[var(--color-border-bright)] bg-[var(--color-bg)] overflow-hidden shadow-2xl">
              {/* macOS-style window bar */}
              <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-bg-elev)]">
                <span className="w-3 h-3 rounded-full bg-[#ff5f57]" />
                <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
                <span className="w-3 h-3 rounded-full bg-[#28c840]" />
                <span className="ml-3 text-[11px] font-mono text-[var(--color-fg-dim)]">
                  equium-gpu-miner
                </span>
                <span className="ml-auto text-[10px] font-mono uppercase tracking-[0.15em] flex items-center gap-1.5 text-[var(--color-mint)]">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-mint)] live-dot" />
                  live · mainnet
                </span>
              </div>
              <div className="text-[12px] leading-[1.7] font-mono p-5 overflow-hidden">
                <TermLog>equium-gpu-miner online</TermLog>
                <TermLog>{"  GPU      "}<Teal>Apple M2 Pro (Metal)</Teal></TermLog>
                <TermLog>{"  miner    "}<Teal>AgbS…AEQM</Teal></TermLog>
                <TermLog>{"  program  "}<Teal>ZKGM…uEQM</Teal></TermLog>
                <div className="h-3" />
                <TermLog><Bold>round #18</Bold>{"   reward 25 EQM   target 0x40ffff…"}</TermLog>
                <TermLog>{"  · try #1   "}<Dim>above target</Dim>{"   84ms    "}<Gold>11.9 H/s</Gold></TermLog>
                <TermLog>{"  · try #2   "}<Dim>above target</Dim>{"   78ms    "}<Gold>12.8 H/s</Gold></TermLog>
                <TermLog>{"  · try #3   "}<Dim>above target</Dim>{"   81ms    "}<Gold>12.3 H/s</Gold></TermLog>
                <TermLog>{"  "}<Sage>✓ MINED!</Sage>{"   "}<Bold>+25 EQM</Bold>{"   try #4   "}<Gold>12.4 H/s</Gold></TermLog>
                <TermLog>{"    "}<Dim>sig YrgmXW…AvNCGY</Dim></TermLog>
                <div className="h-3" />
                <TermLog><Dim>total mined</Dim>{"  "}<Bold>25 EQM</Bold>{"  ·  "}<Dim>blocks</Dim>{"  "}<Bold>1</Bold>{"  ·  "}<Dim>uptime</Dim>{"  "}<Bold>0:08</Bold></TermLog>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function TermLog({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[var(--color-fg-soft)] whitespace-pre">
      <span className="text-[var(--color-teal)] mr-3">INFO</span>
      {children}
    </div>
  );
}

function Teal({ children }: { children: React.ReactNode }) {
  return <span className="text-[var(--color-teal)] font-semibold">{children}</span>;
}
function Sage({ children }: { children: React.ReactNode }) {
  return <span className="text-[var(--color-mint)] font-bold">{children}</span>;
}
function Gold({ children }: { children: React.ReactNode }) {
  return <span className="text-[var(--color-gold)] font-semibold">{children}</span>;
}
function Dim({ children }: { children: React.ReactNode }) {
  return <span className="text-[var(--color-fg-dim)]">{children}</span>;
}
function Bold({ children }: { children: React.ReactNode }) {
  return <span className="text-[var(--color-fg)] font-bold">{children}</span>;
}

function MiniStat({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elev)] px-4 py-3">
      <div className="text-[10px] font-mono uppercase tracking-[0.16em] text-[var(--color-fg-dim)] mb-1">
        {label}
      </div>
      <div
        className={`text-[18px] font-bold ${
          accent ? "text-[var(--color-mint)]" : "text-[var(--color-fg)]"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
