import Link from "next/link";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";

export const metadata = {
  title: "Mine Equium · CLI install guide",
  description:
    "Set up the Equium CLI miner on macOS, Linux, or Windows (via WSL). Build from source in 5 minutes, point it at an RPC, mine $EQM.",
};

export default function DownloadPage() {
  return (
    <main>
      <Navbar />
      <div className="pt-32 pb-20 px-6">
        <div className="max-w-3xl mx-auto">
          <div className="text-[11px] font-mono uppercase tracking-[0.2em] text-[var(--color-rose)] mb-3 font-semibold">
            Mine Equium
          </div>
          <h1 className="text-[40px] md:text-[52px] font-black tracking-[-0.025em] leading-[1.05] mb-5">
            Install the CLI miner.
          </h1>
          <p className="text-[17px] leading-[1.6] text-[var(--color-fg-dim)] max-w-2xl mb-4">
            The CLI miner is the reference implementation: a single Rust
            binary, no Electron, no installer popups, runs headlessly on
            anything that can build the source. It's currently the most
            performant + most reliable way to mine $EQM, and it's what
            we recommend for serious miners.
          </p>
          <p className="text-[15px] leading-[1.6] text-[var(--color-fg-dim)] max-w-2xl mb-10">
            Just want to try mining without installing anything? Use the{" "}
            <Link
              href="/mine"
              className="text-[var(--color-rose)] font-semibold hover:underline"
            >
              browser miner
            </Link>{" "}
            instead. Same protocol, slower because of WASM overhead, but
            zero setup.
          </p>

          {/* OS picker */}
          <div className="grid sm:grid-cols-3 gap-3 mb-10">
            <OsCard
              label="macOS"
              hint="Apple Silicon or Intel"
              href="#macos"
            />
            <OsCard
              label="Linux"
              hint="Ubuntu, Debian, Arch, Fedora"
              href="#linux"
            />
            <OsCard
              label="Windows"
              hint="via WSL2 (recommended)"
              href="#windows"
            />
          </div>

          {/* Common prerequisites */}
          <section className="mb-12">
            <h2 className="text-[22px] font-bold tracking-[-0.015em] mb-3">
              What you'll need
            </h2>
            <ul className="list-disc pl-6 space-y-2 text-[14.5px] leading-[1.65] text-[var(--color-fg-dim)]">
              <li>
                A Solana keypair file. Generate one with{" "}
                <Code>solana-keygen new -o ~/.config/solana/id.json</Code>{" "}
                (the Solana CLI install instructions are part of each section
                below).
              </li>
              <li>
                A small amount of SOL for transaction fees in that keypair's
                address. Roughly 0.01 SOL covers a few hours of mining.
              </li>
              <li>
                A Solana RPC endpoint. A free Helius key is fine —{" "}
                <Link
                  href="/docs/rpc"
                  className="text-[var(--color-rose)] hover:underline"
                >
                  5-minute setup
                </Link>
                . The default public mainnet endpoint will rate-limit you out
                of meaningful mining within seconds.
              </li>
            </ul>
          </section>

          {/* macOS */}
          <Section id="macos" title="macOS">
            <P>
              Native macOS — Apple Silicon or Intel, both work. Open Terminal:
            </P>
            <Block label="1 · Install Rust">
              <Pre>{`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"`}</Pre>
            </Block>
            <Block label="2 · Install the Solana CLI (for keypair generation)">
              <Pre>{`sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"`}</Pre>
            </Block>
            <Block label="3 · Generate a mining keypair">
              <Pre>{`solana-keygen new -o ~/.config/solana/id.json --no-bip39-passphrase
solana-keygen pubkey ~/.config/solana/id.json   # send a bit of SOL here`}</Pre>
            </Block>
            <Block label="4 · Build + run the miner">
              <Pre>{`git clone https://github.com/HannaPrints/equium.git
cd equium
cargo build --release -p equium-cli-miner

./target/release/equium-miner \\
  --rpc-url https://mainnet.helius-rpc.com/?api-key=YOUR_KEY \\
  --keypair ~/.config/solana/id.json \\
  --threads $(sysctl -n hw.physicalcpu)`}</Pre>
            </Block>
          </Section>

          {/* Linux */}
          <Section id="linux" title="Linux">
            <P>
              Tested on Ubuntu 22.04, Debian 12, Arch, and Fedora. Other
              distros work the same — adjust the package manager call.
            </P>
            <Block label="1 · Install build tools">
              <Pre>{`# Debian / Ubuntu
sudo apt update && sudo apt install -y build-essential pkg-config libssl-dev curl git

# Arch
sudo pacman -S --needed base-devel openssl curl git

# Fedora
sudo dnf install -y @development-tools openssl-devel curl git`}</Pre>
            </Block>
            <Block label="2 · Install Rust">
              <Pre>{`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"`}</Pre>
            </Block>
            <Block label="3 · Install the Solana CLI">
              <Pre>{`sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"`}</Pre>
            </Block>
            <Block label="4 · Generate a keypair">
              <Pre>{`solana-keygen new -o ~/.config/solana/id.json --no-bip39-passphrase
solana-keygen pubkey ~/.config/solana/id.json`}</Pre>
            </Block>
            <Block label="5 · Build + run">
              <Pre>{`git clone https://github.com/HannaPrints/equium.git
cd equium
cargo build --release -p equium-cli-miner

./target/release/equium-miner \\
  --rpc-url https://mainnet.helius-rpc.com/?api-key=YOUR_KEY \\
  --keypair ~/.config/solana/id.json \\
  --threads $(nproc)`}</Pre>
            </Block>
          </Section>

          {/* Windows */}
          <Section id="windows" title="Windows">
            <Callout>
              <strong>WSL2 is the path of least resistance.</strong> Native
              Windows + Rust + Solana CLI is theoretically possible but
              accumulates papercuts fast (path handling, OpenSSL, line
              endings). Run Linux inside Windows via WSL2 and skip them.
            </Callout>

            <Block label="1 · Install WSL2 + Ubuntu (one-time)">
              <P>
                Open <strong>PowerShell as Administrator</strong> and run:
              </P>
              <Pre>{`wsl --install -d Ubuntu`}</Pre>
              <P>
                Reboot when prompted, then open the new "Ubuntu" app from
                the Start menu and set a UNIX username + password. You're
                now inside Linux — everything below runs in the Ubuntu
                terminal, not PowerShell.
              </P>
            </Block>

            <Block label="2 · Install build tools (inside WSL)">
              <Pre>{`sudo apt update && sudo apt install -y build-essential pkg-config libssl-dev curl git`}</Pre>
            </Block>

            <Block label="3 · Install Rust">
              <Pre>{`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"`}</Pre>
            </Block>

            <Block label="4 · Install the Solana CLI">
              <Pre>{`sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"`}</Pre>
            </Block>

            <Block label="5 · Generate a keypair + build">
              <Pre>{`solana-keygen new -o ~/.config/solana/id.json --no-bip39-passphrase
solana-keygen pubkey ~/.config/solana/id.json    # send SOL here

git clone https://github.com/HannaPrints/equium.git
cd equium
cargo build --release -p equium-cli-miner

./target/release/equium-miner \\
  --rpc-url https://mainnet.helius-rpc.com/?api-key=YOUR_KEY \\
  --keypair ~/.config/solana/id.json \\
  --threads $(nproc)`}</Pre>
            </Block>

            <Callout tone="dim">
              <strong>Determined to mine on native Windows?</strong> You'll
              need rustup-init.exe, the Solana Windows installer, and a
              C++ build toolchain (Build Tools for Visual Studio with the
              C++ workload). After that the cargo command is the same.
              File a GitHub issue if something specific breaks and we'll
              document a workaround.
            </Callout>
          </Section>

          {/* Performance notes */}
          <Section id="perf" title="Performance notes">
            <P>
              The miner spawns one solver thread per physical core by
              default. Override with <Code>--threads N</Code> if you want to
              leave some cores free for other work. Each thread independently
              grinds nonces; first to find a below-target solution wins the
              round.
            </P>
            <P>
              The auto-retargeter brings difficulty up as more miners join
              the network. Expect your hashrate, in absolute terms, to look
              fine while your share of blocks shrinks — that's the network
              working as designed.
            </P>
            <P>
              <strong>About GPU miners.</strong> Equihash 96,5 is memory-hard
              by design, so GPU advantage is bounded relative to SHA-based
              proof-of-work, but a tuned GPU implementation will still beat
              a CPU. An open-source GPU miner is in the works (
              <Link
                href="/docs/protocol#gpu"
                className="text-[var(--color-rose)] hover:underline"
              >
                see the protocol page
              </Link>
              ). Until then, a multi-core CPU still earns real EQM — the
              retargeter just keeps the network balanced.
            </P>
          </Section>

          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elev)] p-5 md:p-6 mt-12">
            <h3 className="text-[16px] font-bold tracking-[-0.01em] mb-2">
              Stuck?
            </h3>
            <p className="text-[14px] leading-[1.6] text-[var(--color-fg-dim)]">
              The full source is at{" "}
              <a
                href="https://github.com/HannaPrints/equium"
                target="_blank"
                rel="noreferrer noopener"
                className="text-[var(--color-rose)] hover:underline"
              >
                github.com/HannaPrints/equium
              </a>
              . Open an issue if you hit something specific or post in
              the X replies on{" "}
              <a
                href="https://x.com/EquiumEQM"
                target="_blank"
                rel="noreferrer noopener"
                className="text-[var(--color-rose)] hover:underline"
              >
                @EquiumEQM
              </a>
              .
            </p>
          </div>
        </div>
      </div>
      <Footer />
    </main>
  );
}

function OsCard({
  label,
  hint,
  href,
}: {
  label: string;
  hint: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elev)] p-5 hover:border-[var(--color-rose-soft)] transition-colors group"
    >
      <div className="text-[18px] font-bold tracking-[-0.01em] group-hover:text-[var(--color-rose)] transition-colors">
        {label}
      </div>
      <div className="text-[12px] font-mono text-[var(--color-fg-dim)] mt-1">
        {hint}
      </div>
    </Link>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-32 mb-14">
      <h2 className="text-[26px] font-bold tracking-[-0.018em] mb-4">
        {title}
      </h2>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Block({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--color-fg-dim)] mb-2 font-semibold">
        {label}
      </div>
      {children}
    </div>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[14.5px] leading-[1.65] text-[var(--color-fg-soft)]">
      {children}
    </p>
  );
}

function Pre({ children }: { children: React.ReactNode }) {
  return (
    <pre className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4 overflow-x-auto font-mono text-[12.5px] leading-[1.7] text-[var(--color-fg-soft)]">
      {children}
    </pre>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="font-mono text-[12.5px] px-1.5 py-0.5 rounded bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-teal)]">
      {children}
    </code>
  );
}

function Callout({
  children,
  tone = "default",
}: {
  children: React.ReactNode;
  tone?: "default" | "dim";
}) {
  const cls =
    tone === "dim"
      ? "border-[var(--color-border)] bg-[var(--color-bg-elev)] text-[var(--color-fg-dim)]"
      : "border-[var(--color-gold)]/40 bg-[var(--color-gold)]/[0.06]";
  return (
    <div
      className={`rounded-2xl border p-5 my-2 text-[14px] leading-[1.6] ${cls}`}
    >
      {children}
    </div>
  );
}
