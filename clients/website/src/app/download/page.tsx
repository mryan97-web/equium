import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import { DownloadButtons } from "@/components/DownloadButtons";

export const metadata = {
  title: "Download Equium Miner",
  description:
    "Native macOS and Windows desktop miner for Equium ($EQM). Install, generate a wallet, click Start.",
};

export default function DownloadPage() {
  return (
    <main>
      <Navbar />
      <div className="pt-32 pb-20 px-6">
        <div className="max-w-3xl mx-auto">
          <div className="text-[11px] font-mono uppercase tracking-[0.2em] text-[var(--color-rose)] mb-3 font-semibold">
            — Desktop miner —
          </div>
          <h1 className="text-[44px] md:text-[60px] font-black tracking-[-0.03em] leading-[1] mb-5">
            Install and mine.
          </h1>
          <p className="text-[17px] leading-[1.6] text-[var(--color-fg-dim)] max-w-2xl mb-10">
            One installer. Built-in wallet, encrypted on your machine. Fund
            with a few dollars of SOL, click Start, your CPU starts producing
            $EQM. No browser tab to keep open, no extension to install.
          </p>

          <DownloadButtons />

          <div className="mt-14 space-y-8">
            <Note title="What you need">
              <ul className="list-disc pl-6 space-y-2 text-[15px] leading-[1.6] text-[var(--color-fg-dim)]">
                <li>macOS 11+ (Apple Silicon or Intel) or Windows 10/11</li>
                <li>
                  ~0.005 SOL in your generated wallet for transaction fees
                  (about $1 covers ~30 mining attempts)
                </li>
                <li>
                  An RPC endpoint —{" "}
                  <a
                    href="/docs/rpc"
                    className="text-[var(--color-rose)] font-semibold hover:underline"
                  >
                    grab a free Helius key here
                  </a>{" "}
                  (5 min, no credit card). The default public endpoint works
                  for testing.
                </li>
              </ul>
            </Note>

            <Note title="How it works">
              <ol className="list-decimal pl-6 space-y-2 text-[15px] leading-[1.6] text-[var(--color-fg-dim)]">
                <li>Open the app, create a wallet, write down your backup.</li>
                <li>
                  Send a tiny bit of SOL to the address shown (Phantom, Coinbase,
                  any wallet — it's just a Solana address).
                </li>
                <li>
                  Click <span className="font-mono font-bold">Start mining</span>.
                  The app runs Equihash 96,5 on your CPU and submits valid
                  solutions directly to Solana. Each block mined credits 25 EQM
                  to your wallet.
                </li>
              </ol>
            </Note>

            <Note title="Security">
              <p className="text-[15px] leading-[1.6] text-[var(--color-fg-dim)]">
                Your secret key is encrypted with{" "}
                <span className="font-mono font-bold">Argon2id + AES-256-GCM</span>{" "}
                under your password and stored in the app's local data folder.
                The plaintext only exists in memory while the wallet is
                unlocked. We never see your key, your password, or your traffic.
              </p>
            </Note>

            <Note title="Prefer the source?">
              <p className="text-[15px] leading-[1.6] text-[var(--color-fg-dim)]">
                The desktop miner is open source. Build from{" "}
                <a
                  href="https://github.com/HannaPrints/equium/tree/master/clients/desktop-miner"
                  className="text-[var(--color-rose)] font-semibold hover:underline"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  clients/desktop-miner
                </a>{" "}
                in the repo, or use the{" "}
                <a
                  href="https://github.com/HannaPrints/equium/tree/master/clients/cli-miner"
                  className="text-[var(--color-rose)] font-semibold hover:underline"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  CLI miner
                </a>{" "}
                if you'd rather run it headless on a server.
              </p>
            </Note>
          </div>
        </div>
      </div>
      <Footer />
    </main>
  );
}

function Note({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-3xl border border-[var(--color-border)] bg-[var(--color-bg-elev)] p-6 md:p-8">
      <h2 className="text-[20px] font-black tracking-[-0.01em] mb-3">
        {title}
      </h2>
      {children}
    </section>
  );
}
