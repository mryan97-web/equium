use serde::{Deserialize, Serialize};
use solana_sdk::signature::Keypair;
use std::path::PathBuf;

#[derive(Default, Clone, Serialize, Deserialize)]
pub struct PersistedSettings {
    /// Helius / custom RPC URL set by the user. Empty = default to mainnet/devnet.
    pub rpc_url: String,
    /// Solana cluster name ("mainnet-beta", "devnet"). Default "devnet" until launch.
    pub cluster: String,
}

impl PersistedSettings {
    pub fn default_for_first_run() -> Self {
        Self {
            rpc_url: String::new(),
            cluster: "devnet".into(),
        }
    }

    pub fn effective_rpc_url(&self) -> String {
        if !self.rpc_url.is_empty() {
            return self.rpc_url.clone();
        }
        match self.cluster.as_str() {
            "mainnet-beta" | "mainnet" => "https://api.mainnet-beta.solana.com".into(),
            _ => "https://api.devnet.solana.com".into(),
        }
    }
}

pub struct AppState {
    pub data_dir: PathBuf,
    /// Decrypted keypair, only present after `unlock_wallet`. Cleared on lock.
    pub unlocked: Option<Keypair>,
    pub settings: PersistedSettings,
    pub miner: MinerHandle,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> Self {
        let settings_path = data_dir.join("settings.json");
        let settings = std::fs::read_to_string(&settings_path)
            .ok()
            .and_then(|s| serde_json::from_str::<PersistedSettings>(&s).ok())
            .unwrap_or_else(PersistedSettings::default_for_first_run);
        Self {
            data_dir,
            unlocked: None,
            settings,
            miner: MinerHandle::default(),
        }
    }

    pub fn keystore_path(&self) -> PathBuf {
        self.data_dir.join("wallet.json")
    }

    pub fn settings_path(&self) -> PathBuf {
        self.data_dir.join("settings.json")
    }

    pub fn save_settings(&self) -> std::io::Result<()> {
        let s = serde_json::to_string_pretty(&self.settings).unwrap();
        std::fs::write(self.settings_path(), s)
    }
}

#[derive(Default)]
pub struct MinerHandle {
    pub stop_tx: Option<tokio::sync::oneshot::Sender<()>>,
    pub stats: MinerStats,
    pub running: bool,
}

#[derive(Default, Clone, Serialize)]
pub struct MinerStats {
    pub blocks_mined: u64,
    pub total_earned_base: u64,
    pub cumulative_nonces: u64,
    pub started_at_unix_ms: i64,
    pub try_in_round: u32,
    pub last_log: String,
}
