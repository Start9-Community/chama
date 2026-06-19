use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use axum::extract::{Query, State};
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use clap::{Parser, Subcommand};
use fedimint_bip39::{Bip39RootSecretStrategy, Mnemonic};
use fedimint_client::module_init::ClientModuleInitRegistry;
use fedimint_client::secret::RootSecretStrategy;
use fedimint_client::{Client, ClientBuilder, ClientHandleArc, RootSecret};
use fedimint_connectors::ConnectorRegistry;
use fedimint_core::Amount;
use fedimint_core::bitcoin::address::NetworkUnchecked;
use fedimint_core::bitcoin::{Address as BitcoinAddress, Amount as BitcoinAmount};
use fedimint_core::core::OperationId;
use fedimint_core::db::Database;
use fedimint_core::invite_code::InviteCode;
use fedimint_core::secp256k1::PublicKey;
use fedimint_core::util::SafeUrl;
use fedimint_ln_client::common::LightningGateway;
use fedimint_ln_client::{
    LightningClientInit, LightningClientModule, LnReceiveState, OutgoingLightningPayment,
};
use fedimint_meta_client::MetaClientInit;
use fedimint_mint_client::{
    MintClientInit, MintClientModule, OOBNotes, ReissueExternalNotesState,
    SelectNotesWithAtleastAmount, SelectNotesWithExactAmount,
};
use fedimint_wallet_client::client_db::TweakIdx;
use fedimint_wallet_client::{DepositStateV2, WalletClientInit, WalletClientModule, WithdrawState};
use futures::StreamExt;
use lightning_invoice::{Bolt11InvoiceDescription, Description};
use rand::thread_rng;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::Mutex;
use tower_http::cors::{Any, CorsLayer};

const FEDERATION_OPEN_TIMEOUT: Duration = Duration::from_secs(30);
const FEDERATION_JOIN_TIMEOUT: Duration = Duration::from_secs(45);
const GATEWAY_CACHE_REFRESH_TIMEOUT: Duration = Duration::from_secs(8);
const GATEWAY_SELECT_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Debug, Parser)]
#[command(name = "chama-fedimint-bridge")]
#[command(about = "Native Fedimint harness for Chama federation tests")]
struct Cli {
    /// Directory containing the Fedimint client database.
    #[arg(long, env = "CHAMA_FEDIMINT_DATA_DIR")]
    data_dir: PathBuf,

    /// Enable Iroh DHT/PKARR discovery. This is on by default because public
    /// iroh federations often need it.
    #[arg(long, default_value_t = true)]
    iroh_enable_dht: bool,

    /// Enable Fedimint's parallel next-generation Iroh stack.
    #[arg(long, default_value_t = true)]
    iroh_enable_next: bool,

    /// Optional iROH DNS/PKARR resolver URL for Chama-owned discovery infra.
    #[arg(long, env = "CHAMA_FEDIMINT_IROH_DNS")]
    iroh_dns: Option<SafeUrl>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Join a federation using a fed1 invite code.
    Join { invite_code: String },

    /// Print federation id, network, metadata, and balance.
    Info,

    /// Fetch and print registered Lightning gateways.
    ListGateways {
        /// Use the cached gateway list without fetching from guardians.
        #[arg(long, default_value_t = false)]
        no_update: bool,
    },

    /// Fetch gateways and verify gateway API reachability.
    ProbeGateways,

    /// Create a BOLT11 invoice through the federation's LN module.
    Invoice {
        #[arg(long)]
        amount_msats: u64,

        #[arg(long, default_value = "Chama Fedimint native test")]
        description: String,

        #[arg(long)]
        expiry_time: Option<u64>,

        #[arg(long)]
        gateway_id: Option<PublicKey>,

        #[arg(long, default_value_t = false)]
        force_internal: bool,
    },

    /// Wait for a previously-created incoming invoice to settle.
    AwaitInvoice { operation_id: OperationId },

    /// Pay a BOLT11 invoice or LNURL through a gateway.
    Pay {
        payment_info: String,

        #[arg(long)]
        amount_msats: Option<u64>,

        #[arg(long)]
        lnurl_comment: Option<String>,

        #[arg(long)]
        gateway_id: Option<PublicKey>,

        #[arg(long, default_value_t = false)]
        force_internal: bool,

        #[arg(long, default_value_t = false)]
        no_wait: bool,
    },

    /// Spend local balance into out-of-band Fedimint e-cash notes.
    SpendNotes {
        #[arg(long)]
        amount_msats: u64,

        #[arg(long, default_value_t = false)]
        allow_overpay: bool,

        #[arg(long, default_value_t = 60 * 60 * 24 * 7)]
        timeout_secs: u64,

        #[arg(long, default_value_t = false)]
        include_invite: bool,
    },

    /// Redeem/reissue out-of-band Fedimint e-cash notes into this wallet.
    ReissueNotes {
        notes: String,

        #[arg(long, default_value_t = false)]
        no_wait: bool,
    },

    /// Parse out-of-band Fedimint e-cash notes without redeeming them.
    ParseNotes { notes: String },

    /// Print native Fedimint wallet-module on-chain settings.
    OnchainInfo,

    /// Allocate a native Fedimint on-chain peg-in address.
    OnchainDepositAddress,

    /// Wait for a native Fedimint on-chain peg-in to be claimed by the mint.
    AwaitOnchainDeposit { operation_id: OperationId },

    /// Fetch native Fedimint peg-out fees for an on-chain address.
    OnchainWithdrawFees {
        #[arg(long)]
        address: String,

        #[arg(long)]
        amount_sats: u64,
    },

    /// Withdraw ecash balance to an on-chain bitcoin address.
    OnchainWithdraw {
        #[arg(long)]
        address: String,

        #[arg(long)]
        amount_sats: u64,

        #[arg(long, default_value_t = false)]
        no_wait: bool,
    },

    /// Run a localhost JSON API around the native wallet.
    Serve {
        #[arg(long, default_value = "127.0.0.1:8787")]
        bind: SocketAddr,

        #[arg(long)]
        invite_code: Option<String>,
    },

    /// Join/open, print info, probe gateways, and create a tiny invoice.
    Smoke {
        invite_code: String,

        #[arg(long, default_value_t = 1000)]
        amount_msats: u64,
    },
}

#[derive(Debug, Clone)]
struct Bridge {
    data_dir: PathBuf,
    iroh_enable_dht: bool,
    iroh_enable_next: bool,
    iroh_dns: Option<SafeUrl>,
}

#[derive(Debug, Serialize)]
struct JoinOutput {
    joined: String,
    federation_id: String,
}

#[derive(Debug, Serialize)]
struct InfoOutput {
    federation_id: String,
    network: String,
    total_amount_msat: u64,
    meta: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct InvoiceOutput {
    operation_id: OperationId,
    invoice: String,
}

#[derive(Debug, Serialize)]
struct GatewayProbe {
    gateway_id: String,
    vetted: bool,
    api: String,
    available: bool,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
struct PayStartedOutput {
    operation_id: OperationId,
    fee_msat: u64,
}

#[derive(Debug, Serialize)]
struct OnchainInfoOutput {
    network: String,
    finality_delay: u32,
    peg_in_fee_sats: u64,
    peg_out_fee_sats: u64,
    minimum_deposit_sats: u64,
}

#[derive(Debug, Serialize)]
struct OnchainDepositAddressOutput {
    operation_id: OperationId,
    address: String,
    tweak_idx: TweakIdx,
    finality_delay: u32,
}

#[derive(Debug, Serialize)]
struct OnchainDepositSettledOutput {
    status: String,
    operation_id: OperationId,
    amount_sats: Option<u64>,
    outpoint: Option<String>,
    info: InfoOutput,
}

#[derive(Debug, Serialize)]
struct OnchainWithdrawFeesOutput {
    amount_sats: u64,
    fees_sats: u64,
    total_sats: u64,
}

#[derive(Debug, Serialize)]
struct OnchainWithdrawOutput {
    operation_id: OperationId,
    status: String,
    txid: Option<String>,
    fees_sats: u64,
}

#[derive(Debug, Serialize)]
struct SpendNotesOutput {
    operation_id: OperationId,
    requested_amount_msat: u64,
    total_amount_msat: u64,
    notes: String,
}

#[derive(Debug, Serialize)]
struct ReissueNotesOutput {
    operation_id: OperationId,
    total_amount_msat: u64,
    status: String,
}

#[derive(Debug, Serialize)]
struct ParseNotesOutput {
    total_amount_msat: u64,
    federation_id_prefix: String,
    notes_json: serde_json::Value,
}

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();

    let cli = Cli::parse();
    let bridge = Bridge {
        data_dir: cli.data_dir,
        iroh_enable_dht: cli.iroh_enable_dht,
        iroh_enable_next: cli.iroh_enable_next,
        iroh_dns: cli.iroh_dns,
    };

    match cli.command {
        Command::Join { invite_code } => {
            let client = bridge.join(&invite_code).await?;
            print_json(&JoinOutput {
                joined: invite_code,
                federation_id: client.federation_id().to_string(),
            })?;
        }
        Command::Info => {
            let client = bridge.open().await?;
            print_json(&info_output(&client).await?)?;
        }
        Command::ListGateways { no_update } => {
            let client = bridge.open().await?;
            let gateways = bridge.list_gateways(&client, no_update).await?;
            print_json(&json!({
                "gateway_count": gateways.len(),
                "gateways": gateways,
            }))?;
        }
        Command::ProbeGateways => {
            let client = bridge.open().await?;
            let probes = bridge.probe_gateways(&client).await?;
            print_json(&json!({
                "gateway_count": probes.len(),
                "probes": probes,
            }))?;
        }
        Command::Invoice {
            amount_msats,
            description,
            expiry_time,
            gateway_id,
            force_internal,
        } => {
            let client = bridge.open().await?;
            let invoice = bridge
                .invoice(
                    &client,
                    amount_msats,
                    description,
                    expiry_time,
                    gateway_id,
                    force_internal,
                )
                .await?;
            print_json(&invoice)?;
        }
        Command::AwaitInvoice { operation_id } => {
            let client = bridge.open().await?;
            let value = bridge.await_invoice(&client, operation_id).await?;
            print_json(&value)?;
        }
        Command::Pay {
            payment_info,
            amount_msats,
            lnurl_comment,
            gateway_id,
            force_internal,
            no_wait,
        } => {
            let client = bridge.open().await?;
            let value = bridge
                .pay(
                    &client,
                    payment_info,
                    amount_msats,
                    lnurl_comment,
                    gateway_id,
                    force_internal,
                    no_wait,
                )
                .await?;
            print_json(&value)?;
        }
        Command::SpendNotes {
            amount_msats,
            allow_overpay,
            timeout_secs,
            include_invite,
        } => {
            let client = bridge.open().await?;
            let value = bridge
                .spend_notes(
                    &client,
                    amount_msats,
                    allow_overpay,
                    timeout_secs,
                    include_invite,
                )
                .await?;
            print_json(&value)?;
        }
        Command::ReissueNotes { notes, no_wait } => {
            let client = bridge.open().await?;
            let value = bridge.reissue_notes(&client, notes, !no_wait).await?;
            print_json(&value)?;
        }
        Command::ParseNotes { notes } => {
            print_json(&parse_notes(&notes)?)?;
        }
        Command::OnchainInfo => {
            let client = bridge.open().await?;
            print_json(&bridge.onchain_info(&client).await?)?;
        }
        Command::OnchainDepositAddress => {
            let client = bridge.open().await?;
            print_json(&bridge.onchain_deposit_address(&client).await?)?;
        }
        Command::AwaitOnchainDeposit { operation_id } => {
            let client = bridge.open().await?;
            print_json(&bridge.await_onchain_deposit(&client, operation_id).await?)?;
        }
        Command::OnchainWithdrawFees {
            address,
            amount_sats,
        } => {
            let client = bridge.open().await?;
            print_json(
                &bridge
                    .onchain_withdraw_fees(&client, address, amount_sats)
                    .await?,
            )?;
        }
        Command::OnchainWithdraw {
            address,
            amount_sats,
            no_wait,
        } => {
            let client = bridge.open().await?;
            print_json(
                &bridge
                    .onchain_withdraw(&client, address, amount_sats, no_wait)
                    .await?,
            )?;
        }
        Command::Serve { bind, invite_code } => {
            serve_bridge(bridge, bind, invite_code).await?;
        }
        Command::Smoke {
            invite_code,
            amount_msats,
        } => {
            let client = bridge.open_or_join(&invite_code).await?;
            let info = info_output(&client).await?;
            let probes = bridge.probe_gateways(&client).await?;
            let invoice = bridge
                .invoice(
                    &client,
                    amount_msats,
                    "Chama Fedimint native smoke".to_owned(),
                    None,
                    None,
                    false,
                )
                .await?;

            print_json(&json!({
                "info": info,
                "gateway_count": probes.len(),
                "gateway_probes": probes,
                "invoice": invoice,
            }))?;
        }
    }

    Ok(())
}

impl Bridge {
    async fn join(&self, invite_code: &str) -> Result<ClientHandleArc> {
        let invite_code =
            InviteCode::from_str(invite_code).context("invalid federation invite code")?;
        self.join_invite(invite_code).await
    }

    async fn join_invite(&self, invite_code: InviteCode) -> Result<ClientHandleArc> {
        let (builder, db) = self.client_builder().await?;
        let mnemonic = load_or_generate_mnemonic(&db).await?;
        let connectors = self.connectors().await?;
        let root_secret = root_secret_from_mnemonic(&mnemonic);

        let client = tokio::time::timeout(FEDERATION_JOIN_TIMEOUT, async move {
            builder
                .preview(connectors, &invite_code)
                .await
                .context("failed to preview federation invite")?
                .join(db, root_secret)
                .await
                .context("failed to join federation")
        })
        .await
        .context("timed out joining federation")??;

        let client = Arc::new(client);
        self.warm_gateway_cache(&client).await;
        Ok(client)
    }

    async fn open(&self) -> Result<ClientHandleArc> {
        let (builder, db) = self.client_builder().await?;
        let entropy = Client::load_decodable_client_secret_opt::<Vec<u8>>(&db)
            .await
            .context("failed to load client secret")?
            .context("client secret is not present; run join first")?;
        let mnemonic =
            Mnemonic::from_entropy(&entropy).context("invalid stored mnemonic entropy")?;
        let connectors = self.connectors().await?;
        let root_secret = root_secret_from_mnemonic(&mnemonic);

        let client = tokio::time::timeout(
            FEDERATION_OPEN_TIMEOUT,
            builder.open(connectors, db, root_secret),
        )
        .await
        .context("timed out opening Fedimint client")?
        .context("failed to open Fedimint client")?;

        let client = Arc::new(client);
        self.warm_gateway_cache(&client).await;
        Ok(client)
    }

    async fn open_or_join(&self, invite_code: &str) -> Result<ClientHandleArc> {
        let invite_code =
            InviteCode::from_str(invite_code).context("invalid federation invite code")?;
        let requested_federation_id = invite_code.federation_id();

        match self.open().await {
            Ok(client) => {
                let existing_federation_id = client.federation_id();
                if existing_federation_id != requested_federation_id {
                    bail!(
                        "existing Fedimint client database is initialized for federation {existing_federation_id}, but requested invite is for federation {requested_federation_id}; reset local state before switching federations"
                    );
                }
                Ok(client)
            }
            Err(open_err) => self
                .join_invite(invite_code)
                .await
                .with_context(|| format!("open failed before join attempt: {open_err:#}")),
        }
    }

    async fn reset_local_state(&self) -> Result<()> {
        let db_path = self.data_dir.join("client.db");
        for attempt in 0..3 {
            match tokio::fs::remove_dir_all(&db_path).await {
                Ok(()) => {
                    tokio::fs::create_dir_all(&self.data_dir)
                        .await
                        .with_context(|| {
                            format!("failed to recreate data dir {}", self.data_dir.display())
                        })?;
                    return Ok(());
                }
                Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
                Err(error) if attempt < 2 => {
                    eprintln!(
                        "failed to remove Fedimint client database {} on attempt {}: {}; retrying",
                        db_path.display(),
                        attempt + 1,
                        error,
                    );
                    tokio::time::sleep(Duration::from_millis(150)).await;
                }
                Err(error) => {
                    return Err(error).with_context(|| {
                        format!(
                            "failed to remove Fedimint client database {}",
                            db_path.display()
                        )
                    });
                }
            }
        }

        Ok(())
    }

    async fn local_client_db_present(&self) -> bool {
        tokio::fs::metadata(self.data_dir.join("client.db"))
            .await
            .is_ok()
    }

    /// Best-effort: refresh the gateway cache right after a successful
    /// open/join, while the guardians are known-reachable, so funding-time
    /// gateway selection can hit a warm cache instead of forcing a live
    /// guardian RPC at the worst possible moment. Never fails the caller -
    /// a transient warm failure is logged and ignored.
    async fn warm_gateway_cache(&self, client: &ClientHandleArc) {
        match client.get_first_module::<LightningClientModule>() {
            Ok(ln) => {
                match tokio::time::timeout(GATEWAY_CACHE_REFRESH_TIMEOUT, ln.update_gateway_cache())
                    .await
                {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => {
                        eprintln!(
                            "warm_gateway_cache: best-effort gateway cache refresh failed (continuing): {error:#}"
                        );
                    }
                    Err(_) => {
                        eprintln!(
                            "warm_gateway_cache: timed out after {:?} (continuing)",
                            GATEWAY_CACHE_REFRESH_TIMEOUT
                        );
                    }
                }
            }
            Err(error) => {
                eprintln!("warm_gateway_cache: no Lightning module to warm: {error:#}");
            }
        }
    }

    async fn list_gateways(
        &self,
        client: &ClientHandleArc,
        no_update: bool,
    ) -> Result<Vec<fedimint_ln_client::common::LightningGatewayAnnouncement>> {
        let ln = client.get_first_module::<LightningClientModule>()?;
        if !no_update {
            tokio::time::timeout(GATEWAY_CACHE_REFRESH_TIMEOUT, ln.update_gateway_cache())
                .await
                .context("timed out updating gateway cache")?
                .context("failed to update gateway cache")?;
        }
        Ok(ln.list_gateways().await)
    }

    async fn probe_gateways(&self, client: &ClientHandleArc) -> Result<Vec<GatewayProbe>> {
        let ln = client.get_first_module::<LightningClientModule>()?;
        tokio::time::timeout(GATEWAY_CACHE_REFRESH_TIMEOUT, ln.update_gateway_cache())
            .await
            .context("timed out updating gateway cache")?
            .context("failed to update gateway cache")?;

        let gateways = ln.list_gateways().await;
        let mut probes = Vec::with_capacity(gateways.len());
        for announcement in gateways {
            let gateway = announcement.info.clone();
            let gateway_id = gateway.gateway_id.to_string();
            let api = gateway.api.to_string();
            let result = tokio::time::timeout(
                GATEWAY_SELECT_TIMEOUT,
                ln.select_available_gateway(Some(gateway), None),
            )
            .await
            .context("timed out selecting gateway");
            probes.push(match result {
                Ok(Ok(_)) => GatewayProbe {
                    gateway_id,
                    vetted: announcement.vetted,
                    api,
                    available: true,
                    error: None,
                },
                Ok(Err(error)) | Err(error) => GatewayProbe {
                    gateway_id,
                    vetted: announcement.vetted,
                    api,
                    available: false,
                    error: Some(format!("{error:#}")),
                },
            });
        }

        Ok(probes)
    }

    async fn invoice(
        &self,
        client: &ClientHandleArc,
        amount_msats: u64,
        description: String,
        expiry_time: Option<u64>,
        gateway_id: Option<PublicKey>,
        force_internal: bool,
    ) -> Result<InvoiceOutput> {
        let ln = client.get_first_module::<LightningClientModule>()?;
        let gateway = self
            .select_receive_gateway(&ln, gateway_id, force_internal)
            .await?;
        let description = Description::new(description).context("invalid invoice description")?;
        let (operation_id, invoice, _) = ln
            .create_bolt11_invoice(
                Amount::from_msats(amount_msats),
                Bolt11InvoiceDescription::Direct(description),
                expiry_time,
                (),
                gateway,
            )
            .await
            .context("failed to create BOLT11 invoice")?;

        Ok(InvoiceOutput {
            operation_id,
            invoice: invoice.to_string(),
        })
    }

    async fn select_receive_gateway(
        &self,
        ln: &LightningClientModule,
        gateway_id: Option<PublicKey>,
        force_internal: bool,
    ) -> Result<Option<LightningGateway>> {
        if gateway_id.is_some() || force_internal {
            return self
                .get_gateway_with_retries(ln, gateway_id, force_internal, "invoice")
                .await
                .context(
                    "Couldn't reach the requested federation Lightning gateway to create a receive invoice - \
                     no invoice was created and no sats moved.",
                );
        }

        let mut refresh_error: Option<String> = None;
        for attempt in 1..=3 {
            match tokio::time::timeout(GATEWAY_CACHE_REFRESH_TIMEOUT, ln.update_gateway_cache())
                .await
            {
                Ok(Ok(())) => {
                    refresh_error = None;
                    break;
                }
                Ok(Err(error)) => {
                    refresh_error = Some(format!("{error:#}"));
                    if attempt < 3 {
                        eprintln!(
                            "invoice: gateway cache refresh retry {attempt} after a transient failure: {error:#}"
                        );
                        tokio::time::sleep(Duration::from_millis(1200)).await;
                    }
                }
                Err(_) => {
                    refresh_error = Some(format!(
                        "timed out after {:?}",
                        GATEWAY_CACHE_REFRESH_TIMEOUT
                    ));
                    if attempt < 3 {
                        eprintln!("invoice: gateway cache refresh retry {attempt} after timeout");
                        tokio::time::sleep(Duration::from_millis(1200)).await;
                    }
                }
            }
        }

        match tokio::time::timeout(
            GATEWAY_SELECT_TIMEOUT,
            ln.select_available_gateway(None, None),
        )
        .await
        {
            Ok(Ok(gateway)) => {
                let gateway_id = gateway.gateway_id;
                eprintln!("invoice: selected reachable cached gateway {gateway_id}");
                Ok(Some(gateway))
            }
            Ok(Err(select_error)) => {
                if let Some(refresh_error) = refresh_error {
                    bail!(
                        "Couldn't reach the federation's Lightning gateway to create a receive invoice - \
                         no invoice was created and no sats moved. Gateway cache refresh failed: {refresh_error}; \
                         cached gateway selection also failed: {select_error:#}"
                    );
                }

                Err(select_error).context(
                    "Couldn't find a reachable federation Lightning gateway to create a receive invoice - \
                     no invoice was created and no sats moved.",
                )
            }
            Err(_) => {
                if let Some(refresh_error) = refresh_error {
                    bail!(
                        "Couldn't reach the federation's Lightning gateway to create a receive invoice - \
                         no invoice was created and no sats moved. Gateway cache refresh failed: {refresh_error}; \
                         cached gateway selection timed out after {:?}",
                        GATEWAY_SELECT_TIMEOUT
                    );
                }

                bail!(
                    "Couldn't find a reachable federation Lightning gateway to create a receive invoice - \
                     no invoice was created and no sats moved. Gateway selection timed out after {:?}",
                    GATEWAY_SELECT_TIMEOUT
                )
            }
        }
    }

    async fn get_gateway_with_retries(
        &self,
        ln: &LightningClientModule,
        gateway_id: Option<PublicKey>,
        force_internal: bool,
        operation: &str,
    ) -> Result<Option<LightningGateway>> {
        let mut gateway_result = tokio::time::timeout(
            GATEWAY_SELECT_TIMEOUT,
            ln.get_gateway(gateway_id, force_internal),
        )
        .await
        .context("timed out selecting gateway")?;
        let mut attempt = 1u32;
        while gateway_result.is_err() && attempt < 3 {
            eprintln!("{operation}: gateway selection retry {attempt} after a transient failure");
            tokio::time::sleep(Duration::from_millis(1200)).await;
            gateway_result = tokio::time::timeout(
                GATEWAY_SELECT_TIMEOUT,
                ln.get_gateway(gateway_id, force_internal),
            )
            .await
            .context("timed out selecting gateway")?;
            attempt += 1;
        }
        gateway_result
    }

    async fn await_invoice(
        &self,
        client: &ClientHandleArc,
        operation_id: OperationId,
    ) -> Result<serde_json::Value> {
        let ln = client.get_first_module::<LightningClientModule>()?;
        let mut updates = ln
            .subscribe_ln_receive(operation_id)
            .await
            .context("failed to subscribe to incoming invoice")?
            .into_stream();

        while let Some(update) = updates.next().await {
            match update {
                LnReceiveState::Claimed => {
                    return Ok(json!({
                        "status": "paid",
                        "operation_id": operation_id,
                        "info": info_output(client).await?,
                    }));
                }
                LnReceiveState::Canceled { reason } => bail!("invoice canceled: {reason}"),
                _ => {}
            }
        }

        bail!("invoice update stream ended before settlement")
    }

    async fn pay(
        &self,
        client: &ClientHandleArc,
        payment_info: String,
        amount_msats: Option<u64>,
        lnurl_comment: Option<String>,
        gateway_id: Option<PublicKey>,
        force_internal: bool,
        no_wait: bool,
    ) -> Result<serde_json::Value> {
        let ln = client.get_first_module::<LightningClientModule>()?;
        let invoice = fedimint_ln_client::get_invoice(
            &payment_info,
            amount_msats.map(Amount::from_msats),
            lnurl_comment,
        )
        .await
        .context("failed to parse BOLT11/LNURL payment info")?;
        let gateway = ln
            .get_gateway(gateway_id, force_internal)
            .await
            .context("failed to select gateway")?;

        let OutgoingLightningPayment {
            payment_type,
            contract_id: _,
            fee,
        } = ln
            .pay_bolt11_invoice(gateway, invoice, ())
            .await
            .context("failed to start outgoing LN payment")?;
        let operation_id = payment_type.operation_id();

        if no_wait {
            return Ok(serde_json::to_value(PayStartedOutput {
                operation_id,
                fee_msat: fee.msats,
            })?);
        }

        let outcome = ln
            .await_outgoing_payment(operation_id)
            .await
            .context("outgoing LN payment failed")?;
        Ok(serde_json::to_value(outcome)?)
    }

    async fn spend_notes(
        &self,
        client: &ClientHandleArc,
        amount_msats: u64,
        allow_overpay: bool,
        timeout_secs: u64,
        include_invite: bool,
    ) -> Result<SpendNotesOutput> {
        let mint = client.get_first_module::<MintClientModule>()?;
        let requested_amount = Amount::from_msats(amount_msats);
        let timeout = Duration::from_secs(timeout_secs);

        let (operation_id, notes) = if allow_overpay {
            mint.spend_notes_with_selector(
                &SelectNotesWithAtleastAmount,
                requested_amount,
                timeout,
                include_invite,
                (),
            )
            .await
        } else {
            mint.spend_notes_with_selector(
                &SelectNotesWithExactAmount,
                requested_amount,
                timeout,
                include_invite,
                (),
            )
            .await
        }
        .context("failed to spend e-cash notes")?;

        Ok(SpendNotesOutput {
            operation_id,
            requested_amount_msat: amount_msats,
            total_amount_msat: notes.total_amount().msats,
            notes: notes.to_string(),
        })
    }

    async fn reissue_notes(
        &self,
        client: &ClientHandleArc,
        notes: String,
        wait: bool,
    ) -> Result<ReissueNotesOutput> {
        let oob_notes = OOBNotes::from_str(&notes).context("invalid e-cash notes")?;
        let total_amount_msat = oob_notes.total_amount().msats;
        let mint = client.get_first_module::<MintClientModule>()?;
        let operation_id = mint
            .reissue_external_notes(oob_notes, ())
            .await
            .context("failed to start e-cash reissue")?;

        let mut status = "created".to_owned();
        if wait {
            let mut updates = mint
                .subscribe_reissue_external_notes(operation_id)
                .await
                .context("failed to subscribe to e-cash reissue")?
                .into_stream();

            while let Some(update) = updates.next().await {
                match update {
                    ReissueExternalNotesState::Done => {
                        status = "done".to_owned();
                        break;
                    }
                    ReissueExternalNotesState::Failed(error) => {
                        bail!("reissue failed: {error}");
                    }
                    other => {
                        status = format!("{other:?}");
                    }
                }
            }
        }

        Ok(ReissueNotesOutput {
            operation_id,
            total_amount_msat,
            status,
        })
    }

    async fn onchain_info(&self, client: &ClientHandleArc) -> Result<OnchainInfoOutput> {
        let wallet = client.get_first_module::<WalletClientModule>()?;
        let fees = wallet.get_fee_consensus();
        let peg_in_fee_sats = amount_to_floor_sats(fees.peg_in_abs);
        Ok(OnchainInfoOutput {
            network: wallet.get_network().to_string(),
            finality_delay: wallet.get_finality_delay(),
            peg_in_fee_sats,
            peg_out_fee_sats: amount_to_floor_sats(fees.peg_out_abs),
            minimum_deposit_sats: peg_in_fee_sats.saturating_add(1),
        })
    }

    async fn onchain_deposit_address(
        &self,
        client: &ClientHandleArc,
    ) -> Result<OnchainDepositAddressOutput> {
        let wallet = client.get_first_module::<WalletClientModule>()?;
        let finality_delay = wallet.get_finality_delay();
        let (operation_id, address, tweak_idx) = wallet
            .safe_allocate_deposit_address(json!({
                "app": "chama",
                "kind": "onchain-escrow-funding",
            }))
            .await
            .context("failed to allocate safe on-chain deposit address")?;

        Ok(OnchainDepositAddressOutput {
            operation_id,
            address: address.to_string(),
            tweak_idx,
            finality_delay,
        })
    }

    async fn await_onchain_deposit(
        &self,
        client: &ClientHandleArc,
        operation_id: OperationId,
    ) -> Result<OnchainDepositSettledOutput> {
        let wallet = client.get_first_module::<WalletClientModule>()?;
        let mut updates = wallet
            .subscribe_deposit(operation_id)
            .await
            .context("failed to subscribe to on-chain deposit")?
            .into_stream();

        while let Some(update) = updates.next().await {
            match update {
                DepositStateV2::Claimed {
                    btc_deposited,
                    btc_out_point,
                } => {
                    return Ok(OnchainDepositSettledOutput {
                        status: "claimed".to_owned(),
                        operation_id,
                        amount_sats: Some(btc_deposited.to_sat()),
                        outpoint: Some(btc_out_point.to_string()),
                        info: info_output(client).await?,
                    });
                }
                DepositStateV2::Failed(error) => bail!("on-chain deposit failed: {error}"),
                _ => {}
            }
        }

        bail!("on-chain deposit update stream ended before claim")
    }

    async fn onchain_withdraw_fees(
        &self,
        client: &ClientHandleArc,
        address: String,
        amount_sats: u64,
    ) -> Result<OnchainWithdrawFeesOutput> {
        let wallet = client.get_first_module::<WalletClientModule>()?;
        let address = parse_bitcoin_address(&address, wallet.get_network())?;
        let amount = BitcoinAmount::from_sat(amount_sats);
        let fees = wallet
            .get_withdraw_fees(&address, amount)
            .await
            .context("failed to fetch on-chain withdraw fees")?;
        let fees_sats = fees.amount().to_sat();

        Ok(OnchainWithdrawFeesOutput {
            amount_sats,
            fees_sats,
            total_sats: amount_sats.saturating_add(fees_sats),
        })
    }

    async fn onchain_withdraw(
        &self,
        client: &ClientHandleArc,
        address: String,
        amount_sats: u64,
        no_wait: bool,
    ) -> Result<OnchainWithdrawOutput> {
        let wallet = client.get_first_module::<WalletClientModule>()?;
        let address = parse_bitcoin_address(&address, wallet.get_network())?;
        let amount = BitcoinAmount::from_sat(amount_sats);
        let fees = wallet
            .get_withdraw_fees(&address, amount)
            .await
            .context("failed to fetch on-chain withdraw fees")?;
        let fees_sats = fees.amount().to_sat();
        let operation_id = wallet
            .withdraw(
                &address,
                amount,
                fees,
                json!({
                    "app": "chama",
                    "kind": "onchain-escrow-payout",
                }),
            )
            .await
            .context("failed to start on-chain withdraw")?;

        if no_wait {
            return Ok(OnchainWithdrawOutput {
                operation_id,
                status: "created".to_owned(),
                txid: None,
                fees_sats,
            });
        }

        let mut updates = wallet
            .subscribe_withdraw_updates(operation_id)
            .await
            .context("failed to subscribe to on-chain withdraw")?
            .into_stream();

        while let Some(update) = updates.next().await {
            match update {
                WithdrawState::Succeeded(txid) => {
                    return Ok(OnchainWithdrawOutput {
                        operation_id,
                        status: "succeeded".to_owned(),
                        txid: Some(txid.to_string()),
                        fees_sats,
                    });
                }
                WithdrawState::Failed(error) => bail!("on-chain withdraw failed: {error}"),
                WithdrawState::Created => {}
            }
        }

        bail!("on-chain withdraw update stream ended before success")
    }

    async fn client_builder(&self) -> Result<(ClientBuilder, Database)> {
        let mut builder = Client::builder()
            .await
            .context("failed to create Fedimint client builder")?
            .with_iroh_enable_dht(self.iroh_enable_dht)
            .with_iroh_enable_next(self.iroh_enable_next);
        builder.with_module_inits(default_module_inits());

        let db = load_database(&self.data_dir).await?;
        Ok((builder, db))
    }

    async fn connectors(&self) -> Result<ConnectorRegistry> {
        let mut builder = ConnectorRegistry::build_from_client_defaults()
            .iroh_pkarr_dht(self.iroh_enable_dht)
            .iroh_next(self.iroh_enable_next);

        if let Some(iroh_dns) = &self.iroh_dns {
            builder = builder.set_iroh_dns(iroh_dns.clone());
        }

        builder
            .bind()
            .await
            .context("failed to bind Fedimint connectors")
    }
}

#[derive(Clone)]
struct AppState {
    bridge: Bridge,
    client: Arc<Mutex<Option<ClientHandleArc>>>,
}

fn amount_to_floor_sats(amount: Amount) -> u64 {
    amount.msats / 1000
}

#[derive(Debug)]
struct ApiError(anyhow::Error);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = Json(json!({
            "error": format!("{:#}", self.0),
        }));
        (StatusCode::INTERNAL_SERVER_ERROR, body).into_response()
    }
}

impl<E> From<E> for ApiError
where
    E: Into<anyhow::Error>,
{
    fn from(error: E) -> Self {
        Self(error.into())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JoinRequest {
    invite_code: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InvoiceRequest {
    amount_msats: u64,
    description: Option<String>,
    expiry_time: Option<u64>,
    gateway_id: Option<String>,
    force_internal: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AwaitInvoiceRequest {
    operation_id: OperationId,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PayRequest {
    payment_info: String,
    amount_msats: Option<u64>,
    lnurl_comment: Option<String>,
    gateway_id: Option<String>,
    force_internal: Option<bool>,
    no_wait: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpendNotesRequest {
    amount_msats: u64,
    allow_overpay: Option<bool>,
    timeout_secs: Option<u64>,
    include_invite: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReissueNotesRequest {
    notes: String,
    wait: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParseNotesRequest {
    notes: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AwaitOnchainDepositRequest {
    operation_id: OperationId,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OnchainWithdrawFeesRequest {
    address: String,
    amount_sats: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OnchainWithdrawRequest {
    address: String,
    amount_sats: u64,
    no_wait: Option<bool>,
}

async fn serve_bridge(bridge: Bridge, bind: SocketAddr, invite_code: Option<String>) -> Result<()> {
    let state = AppState {
        bridge,
        client: Arc::new(Mutex::new(None)),
    };

    if let Some(invite_code) = invite_code {
        let client = state.bridge.open_or_join(&invite_code).await?;
        *state.client.lock().await = Some(client);
    }

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers(Any);
    let app = Router::new()
        .route("/health", get(api_health))
        .route("/join", post(api_join))
        .route("/reset", post(api_reset))
        .route("/info", get(api_info))
        .route("/gateways", get(api_gateways))
        .route("/probe-gateways", get(api_probe_gateways))
        .route("/invoice", post(api_invoice))
        .route("/await-invoice", post(api_await_invoice))
        .route("/pay", post(api_pay))
        .route("/spend-notes", post(api_spend_notes))
        .route("/reissue-notes", post(api_reissue_notes))
        .route("/parse-notes", post(api_parse_notes))
        .route("/onchain/info", get(api_onchain_info))
        .route(
            "/onchain/deposit-address",
            post(api_onchain_deposit_address),
        )
        .route("/onchain/await-deposit", post(api_await_onchain_deposit))
        .route("/onchain/withdraw-fees", post(api_onchain_withdraw_fees))
        .route("/onchain/withdraw", post(api_onchain_withdraw))
        .layer(cors)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .with_context(|| format!("failed to bind {bind}"))?;
    eprintln!("chama-fedimint-bridge listening on http://{bind}");
    axum::serve(listener, app).await?;
    Ok(())
}

impl AppState {
    async fn client(&self) -> Result<ClientHandleArc> {
        let mut guard = self.client.lock().await;
        if let Some(client) = guard.as_ref() {
            return Ok(client.clone());
        }

        let client = self.bridge.open().await?;
        *guard = Some(client.clone());
        Ok(client)
    }

    async fn join(&self, invite_code: &str) -> Result<ClientHandleArc> {
        let client = self.bridge.open_or_join(invite_code).await?;
        *self.client.lock().await = Some(client.clone());
        Ok(client)
    }

    async fn reset(&self) -> Result<()> {
        let stale_client = self.client.lock().await.take();
        drop(stale_client);
        self.bridge.reset_local_state().await
    }
}

async fn api_health(State(state): State<AppState>) -> Json<serde_json::Value> {
    let joined =
        state.client.lock().await.is_some() || state.bridge.local_client_db_present().await;
    Json(json!({
        "ok": true,
        "joined": joined,
        "api_version": 2,
        "capabilities": [
            "reset",
            "idempotent_join",
        ],
    }))
}

async fn api_join(
    State(state): State<AppState>,
    Json(req): Json<JoinRequest>,
) -> Result<Json<JoinOutput>, ApiError> {
    let client = state.join(&req.invite_code).await?;
    Ok(Json(JoinOutput {
        joined: req.invite_code,
        federation_id: client.federation_id().to_string(),
    }))
}

async fn api_reset(State(state): State<AppState>) -> Result<Json<serde_json::Value>, ApiError> {
    state.reset().await?;
    Ok(Json(json!({ "ok": true })))
}

async fn api_info(State(state): State<AppState>) -> Result<Json<InfoOutput>, ApiError> {
    let client = state.client().await?;
    Ok(Json(info_output(&client).await?))
}

async fn api_gateways(
    State(state): State<AppState>,
    Query(query): Query<BTreeMap<String, String>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let no_update = query
        .get("noUpdate")
        .or_else(|| query.get("no_update"))
        .is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true"));
    let client = state.client().await?;
    let gateways = state.bridge.list_gateways(&client, no_update).await?;
    Ok(Json(json!({
        "gateway_count": gateways.len(),
        "gateways": gateways,
    })))
}

async fn api_probe_gateways(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let client = state.client().await?;
    let probes = state.bridge.probe_gateways(&client).await?;
    Ok(Json(json!({
        "gateway_count": probes.len(),
        "probes": probes,
    })))
}

async fn api_invoice(
    State(state): State<AppState>,
    Json(req): Json<InvoiceRequest>,
) -> Result<Json<InvoiceOutput>, ApiError> {
    let gateway_id = parse_optional_public_key(req.gateway_id.as_deref())?;
    let client = state.client().await?;
    Ok(Json(
        state
            .bridge
            .invoice(
                &client,
                req.amount_msats,
                req.description
                    .unwrap_or_else(|| "Chama Fedimint native test".to_owned()),
                req.expiry_time,
                gateway_id,
                req.force_internal.unwrap_or(false),
            )
            .await?,
    ))
}

async fn api_await_invoice(
    State(state): State<AppState>,
    Json(req): Json<AwaitInvoiceRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let client = state.client().await?;
    Ok(Json(
        state
            .bridge
            .await_invoice(&client, req.operation_id)
            .await?,
    ))
}

async fn api_pay(
    State(state): State<AppState>,
    Json(req): Json<PayRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let gateway_id = parse_optional_public_key(req.gateway_id.as_deref())?;
    let client = state.client().await?;
    Ok(Json(
        state
            .bridge
            .pay(
                &client,
                req.payment_info,
                req.amount_msats,
                req.lnurl_comment,
                gateway_id,
                req.force_internal.unwrap_or(false),
                req.no_wait.unwrap_or(false),
            )
            .await?,
    ))
}

async fn api_spend_notes(
    State(state): State<AppState>,
    Json(req): Json<SpendNotesRequest>,
) -> Result<Json<SpendNotesOutput>, ApiError> {
    let client = state.client().await?;
    Ok(Json(
        state
            .bridge
            .spend_notes(
                &client,
                req.amount_msats,
                req.allow_overpay.unwrap_or(false),
                req.timeout_secs.unwrap_or(60 * 60 * 24 * 7),
                req.include_invite.unwrap_or(false),
            )
            .await?,
    ))
}

async fn api_reissue_notes(
    State(state): State<AppState>,
    Json(req): Json<ReissueNotesRequest>,
) -> Result<Json<ReissueNotesOutput>, ApiError> {
    let client = state.client().await?;
    Ok(Json(
        state
            .bridge
            .reissue_notes(&client, req.notes, req.wait.unwrap_or(true))
            .await?,
    ))
}

async fn api_parse_notes(
    Json(req): Json<ParseNotesRequest>,
) -> Result<Json<ParseNotesOutput>, ApiError> {
    Ok(Json(parse_notes(&req.notes)?))
}

async fn api_onchain_info(
    State(state): State<AppState>,
) -> Result<Json<OnchainInfoOutput>, ApiError> {
    let client = state.client().await?;
    Ok(Json(state.bridge.onchain_info(&client).await?))
}

async fn api_onchain_deposit_address(
    State(state): State<AppState>,
) -> Result<Json<OnchainDepositAddressOutput>, ApiError> {
    let client = state.client().await?;
    Ok(Json(state.bridge.onchain_deposit_address(&client).await?))
}

async fn api_await_onchain_deposit(
    State(state): State<AppState>,
    Json(req): Json<AwaitOnchainDepositRequest>,
) -> Result<Json<OnchainDepositSettledOutput>, ApiError> {
    let client = state.client().await?;
    Ok(Json(
        state
            .bridge
            .await_onchain_deposit(&client, req.operation_id)
            .await?,
    ))
}

async fn api_onchain_withdraw_fees(
    State(state): State<AppState>,
    Json(req): Json<OnchainWithdrawFeesRequest>,
) -> Result<Json<OnchainWithdrawFeesOutput>, ApiError> {
    let client = state.client().await?;
    Ok(Json(
        state
            .bridge
            .onchain_withdraw_fees(&client, req.address, req.amount_sats)
            .await?,
    ))
}

async fn api_onchain_withdraw(
    State(state): State<AppState>,
    Json(req): Json<OnchainWithdrawRequest>,
) -> Result<Json<OnchainWithdrawOutput>, ApiError> {
    let client = state.client().await?;
    Ok(Json(
        state
            .bridge
            .onchain_withdraw(
                &client,
                req.address,
                req.amount_sats,
                req.no_wait.unwrap_or(false),
            )
            .await?,
    ))
}

fn parse_notes(notes: &str) -> Result<ParseNotesOutput> {
    let notes = OOBNotes::from_str(notes).context("invalid e-cash notes")?;
    Ok(ParseNotesOutput {
        total_amount_msat: notes.total_amount().msats,
        federation_id_prefix: notes.federation_id_prefix().to_string(),
        notes_json: notes.notes_json()?,
    })
}

fn parse_optional_public_key(value: Option<&str>) -> Result<Option<PublicKey>> {
    value
        .filter(|value| !value.trim().is_empty())
        .map(PublicKey::from_str)
        .transpose()
        .context("invalid gateway id")
}

fn parse_bitcoin_address(
    value: &str,
    network: fedimint_core::bitcoin::Network,
) -> Result<BitcoinAddress> {
    BitcoinAddress::<NetworkUnchecked>::from_str(value)
        .context("invalid bitcoin address")?
        .require_network(network)
        .with_context(|| format!("bitcoin address is not valid for {network}"))
}

async fn load_database(data_dir: &Path) -> Result<Database> {
    tokio::fs::create_dir_all(data_dir)
        .await
        .with_context(|| format!("failed to create data dir {}", data_dir.display()))?;
    let db_path = data_dir.join("client.db");
    Ok(fedimint_rocksdb::RocksDb::build(db_path)
        .open()
        .await
        .context("could not open rocksdb database")?
        .into())
}

async fn load_or_generate_mnemonic(db: &Database) -> Result<Mnemonic> {
    if let Ok(entropy) = Client::load_decodable_client_secret::<Vec<u8>>(db).await {
        Mnemonic::from_entropy(&entropy).context("invalid stored mnemonic entropy")
    } else {
        let mnemonic = Bip39RootSecretStrategy::<12>::random(&mut thread_rng());
        Client::store_encodable_client_secret(db, mnemonic.to_entropy())
            .await
            .context("failed to store client secret")?;
        Ok(mnemonic)
    }
}

fn root_secret_from_mnemonic(mnemonic: &Mnemonic) -> RootSecret {
    RootSecret::StandardDoubleDerive(Bip39RootSecretStrategy::<12>::to_root_secret(mnemonic))
}

fn default_module_inits() -> ClientModuleInitRegistry {
    let mut registry = ClientModuleInitRegistry::new();
    registry.attach(LightningClientInit::default());
    registry.attach(MintClientInit);
    registry.attach(fedimint_mintv2_client::MintClientInit);
    registry.attach(WalletClientInit::default());
    registry.attach(MetaClientInit);
    registry.attach(fedimint_lnv2_client::LightningClientInit::default());
    registry.attach(fedimint_walletv2_client::WalletClientInit);
    registry
}

async fn info_output(client: &ClientHandleArc) -> Result<InfoOutput> {
    let config = client.config().await;
    let balance = client
        .get_balance_for_btc()
        .await
        .context("failed to load BTC balance")?;
    let network = if let Ok(wallet) = client.get_first_module::<WalletClientModule>() {
        wallet.get_network().to_string()
    } else if let Ok(wallet) =
        client.get_first_module::<fedimint_walletv2_client::WalletClientModule>()
    {
        wallet.get_network().to_string()
    } else {
        "unknown".to_owned()
    };

    Ok(InfoOutput {
        federation_id: client.federation_id().to_string(),
        network,
        total_amount_msat: balance.msats,
        meta: serde_json::to_value(&config.global.meta)?,
    })
}

fn init_tracing() {
    let filter = std::env::var("RUST_LOG").unwrap_or_else(|_| "warn".to_owned());
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .try_init();
}

fn print_json<T: Serialize>(value: &T) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}
