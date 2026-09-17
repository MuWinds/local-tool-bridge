//! The approval bridge between the dispatcher and the GUI.
//!
//! The dispatcher runs on a tokio worker thread; the approval dialog is drawn by
//! the egui thread. This module is the seam: it hands a challenge to the UI over
//! a channel and awaits the human's answer on a oneshot.
//!
//! The important property is that this is **fail-closed**. If the window is gone,
//! the channel is closed, or the user never answers, the call is denied. A
//! timeout that allowed would turn an unattended machine into an allow-all.

use std::sync::Arc;
use std::time::Duration;

use ltb_core::dispatch::{ApprovalChallenge, ApprovalDecision, Approver};
use tokio::sync::{Mutex, mpsc, oneshot};

/// A challenge awaiting a decision in the UI.
pub struct PendingApproval {
    pub challenge: ApprovalChallenge,
    /// `None` once the UI has answered or the request was abandoned.
    pub responder: Option<oneshot::Sender<ApprovalDecision>>,
}

/// Forwards approval requests to the GUI thread.
pub struct GuiApprover {
    /// Sender side of the queue the egui app drains each frame.
    requests: mpsc::UnboundedSender<PendingApproval>,
    /// Whether the window currently exists.
    interactive: Arc<Mutex<bool>>,
    /// How long to wait for a human before denying.
    timeout: Duration,
}

impl GuiApprover {
    /// Creates an approver plus the receiver the UI should drain.
    pub fn new(timeout: Duration) -> (Arc<Self>, mpsc::UnboundedReceiver<PendingApproval>) {
        let (requests, receiver) = mpsc::unbounded_channel();
        let approver = Arc::new(Self {
            requests,
            interactive: Arc::new(Mutex::new(true)),
            timeout,
        });
        (approver, receiver)
    }

    /// Marks the window as gone, so every subsequent `ask` denies immediately.
    pub async fn set_interactive(&self, interactive: bool) {
        *self.interactive.lock().await = interactive;
    }
}

#[async_trait::async_trait]
impl Approver for GuiApprover {
    async fn request(&self, challenge: &ApprovalChallenge) -> Option<ApprovalDecision> {
        // With no window there is nobody to ask, so the call must fail closed.
        if !*self.interactive.lock().await {
            return None;
        }

        let (responder, receiver) = oneshot::channel();
        let pending = PendingApproval {
            challenge: challenge.clone(),
            responder: Some(responder),
        };

        if self.requests.send(pending).is_err() {
            // The UI dropped its receiver, which means the window is closing.
            return None;
        }

        match tokio::time::timeout(self.timeout, receiver).await {
            Ok(Ok(decision)) => Some(decision),
            // The dialog was closed without an answer, or the sender was dropped.
            Ok(Err(_)) => None,
            // The human never responded. Denying is the only safe reading.
            Err(_) => None,
        }
    }

    fn is_interactive(&self) -> bool {
        // `try_lock` keeps this synchronous method cheap; a contended lock means
        // a state change is in flight, and reporting `true` then is harmless
        // because the actual decision still fails closed.
        self.interactive
            .try_lock()
            .map(|flag| *flag)
            .unwrap_or(true)
    }
}
