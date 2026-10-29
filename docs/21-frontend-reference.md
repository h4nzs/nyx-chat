# 21 — Frontend Reference (Web App)

A complete inventory of `web/src`, written to help you find any module quickly. Feature-level behavior lives in `14`–`20`; this is the "what lives where and what it exposes" catalog.

## 21.1 Boot & shell

| File | Role |
|---|---|
| `main.tsx` | Entry: `zodSetup` (must be first) → i18n → render `App` → `registerServiceWorker`; injects `setAuthFailureHandler` (logout on final refresh failure, skipped during bootstrap) |
| `App.tsx` | BrowserRouter + routes; lazy pages under a routes-level `<Suspense>` (LoadingScreen); each global modal in its own `ModalSuspense` boundary (`fallback={null}`) + `preloadOnIdle` chunk warm-up; `bootstrap()`; socket connect; theme/accent; visibility lock; maintenance gate; toast limiter; static overlays for `ServerDownPage` and `ClientVersionRequiredPage` (426) |
| `zodSetup.ts` | `globalThis.__zod_globalConfig.jitless = true` (direct mutation — `zod.config()` is tree-shaken) |
| `i18n.ts` | i18next + HttpBackend + LanguageDetector; `load:'languageOnly'`, `fallbackLng:'en'`, 7 runtime namespaces |
| `index.css` | Tailwind v4 `@theme`, `@custom-variant dark (&:where(.dark,.dark *))`, neumorphic shadows, aurora gradient |

## 21.2 Zustand stores (`store/`, 22 files)

| Store | Key state | Key actions |
|---|---|---|
| `auth.ts` | `user`, `accessToken`, `isBootstrapping`, `hasRestoredKeys`, `isUnlocking`, `blockedUserIds`, in-memory private-key cache | `bootstrap`, `login`, `registerAndGeneratePhrase`, `logout`, `emergencyLogout`, `silentRefresh` (retry 3×), `tryAutoUnlock`, `lockApp`, `setDecryptedKeys`, key/prekey getters, `blockUser`/`unblockUser`, `loadBlockedUsers`. Exports `setupAndUploadPreKeyBundle` |
| `message.ts` (2646 L) | `messages[conv]`, `pendingDecryptions`, `hasMore`, `hasLoadedHistory`, `selectedMessageIds`, `isFetchingMore` | `sendMessage`, `sendReaction`, `uploadFile`, `loadMessagesForConversation`, `loadPreviousMessages`, `loadMessageContext`, `addOptimisticMessage`, `addIncomingMessage`, `updateMessageStatus`, `retrySendMessage`, `processOfflineQueue`, `repairSecureSession`, `reDecryptPendingMessages`, `addSystemMessage`; re-exports `decryptMessageObject` |
| `conversation.ts` (942 L) | `conversations`, `activeId`, `isSidebarOpen`, `loading`, `initialLoadCompleted` | `loadConversations`, `startConversation`, `createGroup`, `addOrUpdateConversation`, `updateConversation`, `deleteConversation`, `deleteGroup`, `addParticipants`/`removeParticipant`/`updateParticipantRole`, `togglePinConversation`, `performHandshake`, `markKeyRotationNeeded`, `updateConversationLastMessage`, `resyncState` |
| `messageInput.ts` | `replyingTo`, `editingMessage`, `expiresIn`, `isViewOnce`, `isHD`, `isVoiceAnonymized`, `stagedFiles` | `sendMessage`, `uploadFile`, `sendEdit`, `fetchTypingLinkPreview`, `addStagedFiles`, `handleStopRecording`, `retrySendMessage` |
| `burner.ts` | `hostDeviceId/PqPk/ClassicalPk/UserId`, `activeSessions`, `messages`, `isInitialized` | `initializeFromHash`, `sendMessage`, `receiveMessage`, `terminateSession`, `destroyBurnerSession`, `reset`; exports `generateBurnerLink` |
| `callStore.ts` | `callState`, `remoteUsers/Streams`, `isVideoCall`, `isReceivingCall`, `localStream`, `isMinimized` | `setCallState`, `setIncomingCall`, `setOutgoingCall`, `add/removeRemote*`, `toggleMinimize`, `endCall`, `setCallKey` |
| `commandPalette.ts` | `isOpen`, `commands[]` | `open`, `close`, `toggle`, `addCommands`, `removeCommands` |
| `connection.ts` | `status`, `myDevices`, `hasFetchedDevices` | `setStatus`, `fetchMyDevices`; exports `clearReconnectTimer` |
| `clientVersionGate.ts` | `rejection` (`too-old` \| `version-required`, `minimumVersion`, `clientVersion`), `dismissed` | `report` (severity: `too-old` never downgraded), `dismiss` (only `version-required`), `reset`; `reportClientVersionRejection` maps a 426 body. Rendered by `pages/ClientVersionRequiredPage.tsx` — a full screen, not a toast |
| `contextMenu.ts` | `isOpen`, `x`, `y`, `options[]`, `reactions` | `openMenu`, `closeMenu` |
| `dynamicIsland.ts` | `activities[]` | `addActivity`, `updateActivity`, `removeActivity` |
| `keychain.ts` | `lastUpdated` | `keysUpdated()` |
| `messageSearch.ts` | `searchResults[]`, `highlightedMessageId`, `searchQuery`, `isSearching` | `searchMessages`, `setHighlightedMessageId`, `clearSearch` |
| `modal.ts` | confirm/profile/password-prompt/chat-info flags | `showConfirm`/`hideConfirm`, `open/closeProfileModal`, `show/hidePasswordPrompt`, `open/closeChatInfoModal` |
| `notification.ts` | `notifications[]`, `unreadCount` | `addNotification`, `markAllAsRead`, `clearNotifications`, `removeNotificationsForConversation` |
| `presence.ts` | `onlineUsers` (Set), `typingIndicators` | `setOnlineUsers`, `userJoined`, `userLeft`, `addOrUpdate`, `clear` |
| `profile.ts` | `profiles` cache | `decryptAndCache`, `getCacheOnly` |
| `settings.ts` | `privacyCloak` | `setPrivacyCloak` |
| `story.ts` | `stories[]`, `lastFetched`, `isLoading` | `fetchActiveStories`, `postStory` |
| `systemStore.ts` | `maintenance`, `banner` | `checkStatus` (60 s poll), `setBanner` |
| `theme.ts` | `theme`, `accent` | `toggleTheme`, `setAccent` |
| `verification.ts` | `verifiedStatus` | `loadInitialStatus`, `setVerified`, `unsetVerified`, `computeFingerprint` |

## 21.3 Lib modules (`lib/`, 89 files)

**Pencarian privat & grup anonim (docs/10 §10.18–§10.19):**
- `ohttpClient.ts` / `ohttpPin.ts` — ambil `application/ohttp-keys`, pin digest per key id (fail-closed bila config berubah tanpa rotasi), minta token 120 dtk lalu kirim amplop lewat `/api/ohttp/relay` (default same-origin).
- `pirParams.ts` / `pirClient.ts` — params PIR (`ETag`, cache 60 dtk, hint/filter/seed), query/process lewat worker WASM; `PIR_REQUIRES_OHTTP` bila OHTTP mati (tidak ada fallback ke `/search`).
- `searchOprfClient.ts` / `userSearch.ts` — blind index OPRF (43-char Argon2id → 64-hex) dan **satu pintu** pencarian: OPRF → PIR bila aktif, lalu OHTTP, tanpa fallback diam-diam.
- `groupSync.ts` / `groupMailbox.ts` / `groupPseudonyms.ts` / `privacyPass.ts` — sync grup anonim (token di body + OHTTP POST, opsional Privacy Pass Blind RSA yang disegel di `kvStore`).

**Crypto / storage**
- `crypto-worker-proxy.ts` — main↔worker proxy: `deriveKeyFromPassword`, `registerAndGenerateKeys`, `generateNewKeys`, `retrievePrivateKeys`, `restoreFromPhrase`, `recoverAccountWithSignature`, `getRecoveryPhrase`, `encryptProfile`/`decryptProfile`/`generateProfileKey`, `hashUsername`, `minePoW`, `generateSafetyNumber`, `worker_crypto_secretbox_xchacha20poly1305_*`, `worker_pq_box_seal_v2(_open)`, `workerXChaChaSeal/Open`, `worker_x3dh_v2_*`, `worker_file_encrypt/decrypt`, `reEncryptBundleFromMasterKey`.
- `keyStorage.ts` — `save/getEncryptedKeys`, `clearKeys`, `hasStoredKeys`, `save/getDeviceAutoUnlockKey`, `set/getDeviceAutoUnlockReady`, `setPanicPassword`/`checkPanicPassword`.
- `keychainDb.ts` — at-rest `ENC1:` encrypt/decrypt; group sender/receiver state; skipped keys; OTPK; session keys; profile key; cached group participants. (The plaintext JSON export/import pair was deleted 2026-10-29; `.nyxbak` in `backupRestore.ts` is the only backup path — `docs/31` §31.6.)
- `backupFormat.ts` / `backupPayload.ts` / `backupTransport.ts` / `backupRestore.ts` — framed `.nyxbak` backup: byte layout + AEAD, table↔frame mapping, manual/R2 transport, and replacement-device restore (`createFramedBackup`, `restoreFramedBackup`, `openFramedBackupWithPhrase`, Dexie adapters) — `docs/31`.
- `shadowVaultDb.ts` — `shadowVault` proxy: conversation + message + PQ-DR session + story key persistence; `encryptVaultText`/`decryptVaultText`.
- `db.ts` — Dexie `NyxUnifiedDB` schema (all tables + indexes).
- `localAtRest.ts` — local IndexedDB metadata hardening: `bucketLocalTimestamp` (15-min bucket = server bucket), `sealLocalNumber`/`openLocalNumber`, `sealLocalText`/`openLocalText`, `sealLocalFlag`/`openLocalFlag`. Old plaintext rows stay readable (`openLocal*`) and get sealed on rewrite or by the unlock migration (`migrateAtRestSealing`).
- `localOrderKey.ts` (+ leaf `localOrderBucket.ts`) — two-layer message ordering: plaintext `orderBucketMs` (range-scannable) + sealed `createdAtSealed` (precision). Readers must take the boundary bucket WHOLE; see `docs/30` §30.20.
- `searchIndex.ts` — in-memory search index built from already-decrypted messages while the vault is open (no plaintext FTS on disk); `searchBench.ts` measures index build + memory.
- `fuzzParsers.ts` — deterministic fuzz campaign for untrusted-input parsers (`parseTransportHello`, backup header/archive/chunk/padding); runner + self-test in `__tests__/fuzzParsers.test.ts` (`docs/11` §11.1c).
- `tokenStorage.ts` — cookie helpers: `EMBED_ACCESS_COOKIE` (`embed_at`) + `setEmbedAccessCookie` (expiry follows the token's `exp`), `eraseCookie`, `clearAuthCookies`. Never writes the session cookie name `at`.
- `biometricUnlock.ts` — WebAuthn PRF setup/unlock.
- `sodiumInitializer.ts` — `getSodium`, `initializeSodium`.
- `refreshLock.ts` — `runExclusive` cross-tab mutex.
- `opfsStorage.ts` — encrypted attachment OPFS cache.
- `burnerFileData.ts` — `extractBurnerFileData`.

**Auth / API / transport**
- `api.ts` — `api`, `authFetch` (CSRF + 401-refresh-retry), `apiUpload`, `getCsrfToken`, `handleApiError`, `setAuthFailureHandler`, `getPreKeyBundle`.
- `apiErrorText.ts` — **satu-satunya** pemetaan error REST/realtime → teks tampilan: `apiErrorHint` (status + kode mesin + kalimat server), `apiErrorKey`, `formatApiError`, `formatApiErrorOr` (kalimat konteks bila server diam), `formatApiOrLocalError` (error perangkat tetap apa adanya), `formatApiErrorCode`, `apiErrorTranslator` (membaca namespace `errors`). Kode mesin (`RATE_LIMITED`, `TOKEN_STALE`, `MEMBERS_REMAIN`) tidak pernah menjadi teks; kuncinya ada di `public/locales/*/errors.json`.
- `sandboxLimitNotice.ts` — `reportSandboxLimit(error?)`: batas akun belum terverifikasi (`SANDBOX_LIMIT*`) adalah keadaan, jadi tampil sebagai `SystemBanner` dengan CTA verifikasi (bertahan saat `systemStore.checkStatus` poll), bukan toast sekilas.
- `transportClient.ts` — `NyxWebTransportClient` (EventEmitter), `connectSocket`, `disconnectSocket`, `emitSessionKeyRequest/Fulfillment`, `emitGroupKeyDistribution/Request/Fulfillment`, `emitMetadataUpdated`, `fireGhostSync`; singleton `transportClient`.
- `socketListeners.ts` — `initSocketListeners()`: transport events → stores; offline sync.
- `webrtc.ts` — call signaling + peer connections.
- `serviceWorkerRegistration.ts`.

**Pipeline / media**
- `messagePipeline.ts` — `decryptMessageObject`, `evaluateControlMessage`, `createRepliedToForStoryReply`.
- `r2.ts` — `uploadToR2`.
- `fileUtils.ts` — `isImageFile`/`isVideoFile`/`isAudioFile`, `compressImage`.
- `prefetch.ts` — `prefetchAppChunks()` (lazy-chunk warm-up).
- `nukeProtocol.ts` — `executeLocalWipe`.
- `offlineQueueDb.ts` — offline send queue.
- `storyCrypto.ts` — story encrypt/decrypt.

## 21.4 Pages (`pages/`, 20)

`Login`, `Register`, `Restore`, `Chat`, `SettingsPage`, `KeyManagementPage`, `SessionManagerPage`, `ProfilePage`, `AdminDashboard`, `BurnerChat` (`/drop`), `ConnectPage`, `EmbedChatPage`, `MaintenancePage`, `NotFoundPage`, `LinkDevicePage` (QR perangkat baru, `/link`; juga bisa dibuka dari modal recovery di `/login`), `UsernameLinkPage`, `ServerDownPage`, `PqDeviceBenchPage`. (See the page table in `06-frontend.md` §6.8 and feature docs.)

## 21.5 Components (`components/`, 67 + 5 `ui/`)

- **Global modals (lazy in App.tsx):** `ConfirmModal`, `UserInfoModal`, `PasswordPromptModal`, `ChatInfoModal`, `DynamicIsland`, `CommandPalette`, `ContextMenu`, `CallOverlay`, `SystemInitModal`.
- **Chat core:** `ChatList`, `ChatWindow`, `ChatItem` (conversation row), `MessageItem`, `MessageBubble`, `MessageInput`, `MessageSkeleton`, `TypingIndicator`, `Reactions`, `FileAttachment`, `LazyImage`, `LinkPreviewCard`, `VoiceMessagePlayer`, `MarkdownMessage`, `NewMessageToast`, `EncryptionStatusNotification`, `AuthForm` (shared login/register form).
- **Panels/modals:** `GroupInfoPanel`, `UserInfoPanel`, `ParticipantList`, `SearchMessages`, `CreateGroupChat`, `EditGroupInfoModal`, `AddParticipantModal`, `CreateBurnerModal`, `RecoveryPhraseModal`, `BackupRestoreModal` (manual `.nyxbak` restore, dari berkas atau salinan awan — `docs/31` §31.6c), `BackupExportModal` (membuat `.nyxbak` ber-kunci recovery phrase + opsi unggah ke R2 — `docs/31` §31.6b), `SubscriptionModal`, `CreateStoryModal`, `StoryViewer`, `StoryTray`, `ScanQRModal`, `ShareProfileModal`, `SafetyNumberModal`, `BanUserModal`, `ReportUserModal`, `ReportBugModal`, `Lightbox`, `MediaGallery`, `ImageCropperModal`, `ImageEditorModal`, `AttachmentCropperModal`, `OnboardingTour`, `StartNewChat`, `KeyManagement`.
- **Chrome:** `ConnectionStatusBanner`, `SystemBanner`, `PrivacyCloak`, `ErrorBoundary`, `SEO`, `LanguageSwitcher`, `ProtectedRoute`, `NotificationBell` (bell + popover trigger), `NotificationPopover` (in-app notification list).
- **`ui/` primitives:** `ModalBase`, `Portal`, `card`, `DefaultAvatar`, `AnimatedTabs`; plus `Spinner`, `Alert`, `OnlineDot`, `SwipeableItem`.

## 21.6 Workers (`workers/`)

- `ohttp.worker.ts` (120 L) — bungkus/buka amplop OHTTP (HPKE + Binary HTTP) di worker supaya kunci sesi tidak menyentuh main thread.
- `pir.worker.ts` (138 L) — ABI WASM ChalametPIR (`setup`/`query`/`process`), memuat `pir-client.wasm` dari asset URL (bukan bundle utama).
- `crypto.worker.ts` (2498 L) — 45+ operations: identity keys, XChaCha primitives, Argon2id KDF, PoW, profiles, PQX3DH, Double Ratchet, group sender-key, burner PQ-DR, file secretstream, safety number. Protocol `{id,type,payload}` → `{id,success,result,error}`.
- `transport.worker.ts` (472 L) — WebTransport QUIC: CONNECT/DISCONNECT/SEND_STREAM/SEND_DATAGRAM/START_HANDSHAKE; chaffing loop; frame parsing.

## 21.7 Hooks (`hooks/`, 10) & utils (`utils/`, 17 + tests)

- Hooks: `useChatList`, `useConversation`, `useEdgeSwipe`, `useGlobalEscape`, `useGlobalShortcut`, `useOrientation`, `usePushNotifications`, `useUserProfile`, `useUserSearch` (OPRF/PIR path), `usePresenceSubscription`.
- Utils: `crypto.ts` (engine kunci utama), `safetyNumber.ts`, `fingerprint.ts`, `typeGuards.ts`, `sanitize.ts`, `url.ts`, `systemAlerts.ts`, `feedback.ts`, `date.ts`, `color.ts`, `canvasUtils.ts`, `blobCache.ts`, `messageOrder.ts`, `messagePreview.ts`, `modalPreload.ts`, `tempId.ts`, `usernameLink.ts`.

## 21.7b Types & test setup

- `types/crypto-common.ts` — `CryptoBuffer`, `SodiumKeyPair`, ratchet state/header aliases.
- `types/declarations.d.ts`, `vite-env.d.ts` — global/Vite declarations.
- `SetupTests.ts` — Vitest setup (mocks `localStorage` + `Web Worker`, Buffer polyfill).

## 21.8 i18n & PWA

- Locales `public/locales/{en,es,id,pt-BR}` × 7 namespaces (`common, auth, errors, chat, settings, modals, admin`) — exactly matching the `ns` array in `i18n.ts`. Every key must exist in all four languages. (Former `privacy/help/landing` namespaces were dead copies of the marketing site's locales and were removed — the marketing Astro site keeps its own under `marketing/src/locales`.)
- PWA: `vite-plugin-pwa` injectManifest, source `src/sw.ts`; no `/api` runtime caching by design.

## 21.9 E2E (`e2e/`, 14 specs + global setup)

`auth` (register/login), `chat` (2-page messaging), `profile` (name/bio), `security` (sessions), `settings` (emergency eject), `transport` (WebTransport latency + unsend, auto-skip when unsupported), `call` (coturn relay nyata, skip tanpa TURN), `deviceLinking` (QR), `recovery` (phrase restore), `regression` (burner/story/jebakan UI), `spqr` (ratchet v2 + rollback), `pqV2`, `pqBenchThrottle`, `ohttp` (jalur relay→gateway di stack terpisah, `playwright.ohttp.config.ts`), `global.setup` (DB+Redis reset). Run serially (`workers: 1`).
