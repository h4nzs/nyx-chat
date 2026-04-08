# 🛡️ NYX Security Protocols & Vulnerability Disclosure

**NYX** is designed as a military-grade, Zero-Knowledge messaging architecture. We take the security of our cryptographic implementations, socket protocols, and user privacy extremely seriously.

If you are a security researcher, cryptographer, or an operative who has discovered a vulnerability, we strictly request that you follow this Coordinated Disclosure Protocol.

## 🚨 DO NOT OPEN A PUBLIC ISSUE
**Under no circumstances should you report critical security vulnerabilities via public GitHub Issues, Pull Requests, or Discussions.** Doing so compromises the security of all active NYX deployments and users.

## ✉️ Reporting a Vulnerability (Classified Channel)
Please report any suspected security vulnerabilities directly to the core command at:
**[admin@nyx-app.my.id]** *(We highly recommend using a secure email provider like ProtonMail).*

**In your report, please include:**
1. **Target:** The specific module (e.g., WebAuthn PRF, Double Ratchet implementation, WebSocket layer, IndexedDB storage).
2. **Reconnaissance:** Step-by-step instructions to reproduce the vulnerability.
3. **Impact:** What can an attacker achieve? (e.g., bypass E2EE, trigger a DDoS, extract local keys).
4. **Proof of Concept (PoC):** A script or detailed technical explanation proving the exploit.

## ⏱️ Incident Response Protocol
Once we receive your report, our operational timeline is as follows:
* **Acknowledgment:** We will verify receipt of your report within **48 hours**.
* **Triage & Patching:** We will assess the severity and begin drafting a hotfix in a private, sandboxed environment.
* **Coordinated Release:** Once the patch is deployed, we will publicly acknowledge your contribution and grant you the clearance to publish your findings (if you wish to do so).

## 🎯 Scope of Interest
We are particularly interested in finding flaws in:
- The Double Ratchet / Signal Protocol adaptation.
- Client-side E2EE bypasses.
- WebAuthn PRF key extraction or biometric spoofing.
- Blind Indexing hash collisions.
- Socket event hijacking or race conditions.

## 🎖️ Hall of Fame / Bounty
At this current stage, NYX is a highly specialized open-source project and does not offer financial bug bounties. However, researchers who submit valid, critical vulnerability reports will receive **immense respect, public credit in our release notes (Hall of Fame), and written endorsements** for their professional portfolios.

### 🏆 The Elite Operatives
We deeply appreciate the following researchers who have successfully breached our defenses and helped make NYX more secure. Your names are permanently etched into the NYX architecture:

| Operative (Name / Handle) | Date | Vulnerability Class | Portfolio / Social Link |
| :--- | :--- | :--- | :--- |
| **faiqalfaruq** | 2026-04-03 | DOM-Based XSS (Pre-load App Execution) | [GitHub](https://github.com/faiqalfaruq) |

> *"Security is a continuous operation, not a state of rest."*
