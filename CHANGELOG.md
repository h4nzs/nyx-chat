# Changelog

All notable changes to this project will be documented in this file.

## [1.8.0] - 2026-01-19

This is a major stability and architectural release focused on delivering a fully functional, robust, and user-friendly "Link Device" feature. It resolves a series of deep, interconnected bugs in the authentication, cryptography, and real-time state management layers.

### Added

-   **Fully Functional "Link Device" Feature:** Users can now seamlessly and reliably link a new device by scanning a QR code. The new device is set up automatically without requiring password entry, providing a modern and convenient onboarding experience.

### Fixed

-   **CRITICAL: Complete Overhaul of Device Linking Flow:** Diagnosed and fixed a cascade of critical bugs that previously made the feature unusable.
    -   **UI Stability:** Resolved a persistent crash on the QR scanner page (`DeviceScannerPage`) by correctly managing the camera lifecycle within React.
    -   **Race Condition Elimination:** Fixed a critical race condition where global application logic (`App.tsx`) would prematurely terminate the guest WebSocket connection or trigger unauthorized API calls during the linking process.
    -   **Cryptographic Integrity:**
        *   Resolved a fundamental data format mismatch between the client and the crypto worker, fixing an `incomplete input` error.
        *   Fixed a subtle key derivation mismatch, where the encryption key did not match the decryption key, resolving the `wrong secret key for the given ciphertext` error.
        *   Corrected the encrypted payload structure to match the exact format expected by the decryption function in the crypto worker.
-   **Authentication Flow Robustness:**
    -   **Registration:** Fixed a bug that caused the initial secure key upload (`setupAndUploadPreKeyBundle`) to fail after a user registered a new account.
    -   **Login:** Improved the login flow to immediately decrypt and cache local keys using the login password, removing a redundant password prompt.
-   **Build Stability:** Resolved multiple TypeScript syntax and type errors that were preventing successful production builds.

### Changed

- **Improved Help & FAQ:** The content of the Help page (`HelpPage.tsx`) and the security info modal (`ChatInfoModal.tsx`) has been completely rewritten to be more accurate, comprehensive, and to correctly explain the new "Link Device" feature as the primary method for adding devices.

## [1.7.1] - 2025-12-29

This is a massive stability, security, and architectural hardening release that resolves numerous critical bugs, race conditions, and security vulnerabilities, particularly within the End-to-End Encryption (E2EE) and real-time state synchronization systems.

### Changed

-   **Major E2EE Decryption Refactor:** Rearchitected the entire message decryption flow to eliminate critical race conditions. All decryption logic is now centralized in a single function (`decryptMessageObject`) which acts as the "single source of truth". It now robustly determines the message context (1-on-1 vs. Group) based on the message's `sessionId` rather than relying on potentially stale component state.
-   **Robust Key Rotation & Request Handling:**
    -   The key rotation process for groups is no longer "fire-and-forget". It now features an automatic retry mechanism with exponential backoff.
    -   Key requests for missing group keys now have a timeout and retry limit. If all retries fail (e.g., no other users are online), messages will now display a final "Key request timed out" error instead of being stuck in a "waiting" state indefinitely.

### Fixed

-   **CRITICAL SECURITY: Invalid Key Distribution Vulnerability:** Patched a critical vulnerability where any authenticated user could distribute encryption keys to any conversation, even those they were not a part of. The server now strictly validates that the key distributor is a member of the target conversation.
-   **CRITICAL SECURITY: Reply Chain DoS Vulnerability:**
    -   Hardened the client-side decryption logic to prevent infinite recursion or stack overflow crashes when processing messages with circular or excessively deep reply chains.
    -   Added server-side validation to reject new messages that would create a reply chain deeper than a set limit.
-   **CRITICAL SECURITY: History Leak on Re-join:** Fixed a major privacy leak where a user who was kicked from and then re-added to a group could see the message history from their original membership period after a page reload. The server now correctly resets the user's "joined at" timestamp upon re-joining.
-   **CRITICAL SECURITY: Key Material Leaked in Logs:** Removed multiple `console.log` statements that were insecurely printing sensitive cryptographic key material in the browser console.
-   **Real-time & State Synchronization Bugs:**
    -   Fixed a bug where the group member list in the UI would not update in real-time when a user was added or removed.
    -   Fixed an issue where a user kicked from a group would still receive notifications for new messages in that group. The client now correctly ignores events for conversations it has left.
    -   Fixed a bug where an Admin's special controls (e.g., "add member") would disappear after reloading the page. The server now consistently provides the user's role data.
-   **General Stability:**
    -   Fixed multiple `ReferenceError` crashes caused by missing imports or undeclared variables in the crypto and state management modules.
    -   Fixed a bug where the "retry send" feature would not work correctly for messages that were replies.

## [1.7.0] - 2025-12-27

This is a major architectural and stability release that introduces significant performance improvements for end-to-end encryption (E2EE) and fixes critical bugs in the group chat implementation.

### Added

- **Cryptography Offloading to Web Workers:** All heavy cryptographic operations (key generation, encryption, decryption) have been moved off the main UI thread and into a dedicated Web Worker. This prevents the UI from freezing during intensive crypto calculations, resulting in a significantly smoother and more responsive user experience, especially on lower-end devices.
- **Functional Group Chat E2EE:** Implemented the foundational layer for secure group conversations. This version uses a **shared group key** model where a single, securely distributed key is used by all members to encrypt and decrypt messages. This provides a robust and efficient E2EE baseline for group chats.

### Fixed

- **Critical Group Chat E2EE Bug:** Diagnosed and fixed a series of complex, interconnected bugs that prevented group chats from functioning correctly.
  - **Key Distribution Failure:** Fixed a critical flaw where group encryption keys were generated by the sender but never successfully distributed to other participants. This was traced to both a missing server-side socket listener and client-side logic that failed to trigger distribution at the correct time. The system now reliably distributes keys to all members before a message is sent.
  - **Missing Public Key Data:** Fixed a bug where the server would not send participants' public keys when fetching conversation data. This was the final root cause of the "Participant has no public key" error.
  - **Incorrect Encryption Path:** Fixed the underlying issue that caused the application to mistakenly use 1-on-1 encryption logic for group messages, which led to the "No session key available" error. The correct group encryption path is now always used.

## [1.6.0] - 2025-12-02

This is a massive stability and security release that resolves numerous critical bugs throughout the application, with a major focus on making the end-to-end encryption (E2EE) system and real-time features robust, secure, and reliable.

### Fixed

- **Critical End-to-End Encryption Overhaul:**
  - Resolved a persistent and complex bug that caused initial E2EE sessions to fail. The fix involved correcting the client-side key derivation logic, ensuring the server correctly stores all required cryptographic keys, and fixing database relationships (`PrismaClientValidationError`).
  - The client now correctly handles session keys generated by both client-side handshakes and server-side ratchets, fixing an architectural mismatch that led to `404` errors.
  - Corrected the client-side key generation and storage process to ensure all necessary private keys (`identity`, `signing`, `signedPreKey`) are deterministically created and stored, enabling the recipient-side key derivation to succeed.

- **Security & Data Integrity:**
  - Removed a silent fallback to non-encrypted conversations, which was a critical security risk. The application will now explicitly fail if a secure session cannot be established.
  - Fixed an authorization vulnerability where any user could react to messages in conversations they were not a part of.
  - Fixed another authorization vulnerability where users could fetch messages from conversations they were not a part of.
  - Ensured conversation and session key creation is now an atomic database transaction to prevent orphaned or inconsistent data.
  - Fixed a data integrity issue where a user's primary identity key (`User.publicKey`) was not being updated correctly in all scenarios.

- **Real-time & UI Functionality:**
  - **Read Receipts:** Fixed a bug preventing read receipts from working. The status of messages now updates in real-time when a recipient views them.
  - **Profile Updates:** Fixed a bug where user profile updates were not reflected in real-time for other users.
  - **Notifications:** Fixed both the "Dynamic Island" and Notification Bell features, which were not showing notifications for new messages in inactive chats.
  - **Message Bubble Deletion:** Fixed a UI rendering bug where deleting a message would cause its bubble to incorrectly display the content of the message below it.
  - **State Management on Logout:** Fixed a critical bug where logging out and logging back in without a page refresh would cause application errors. The logout process now fully and correctly resets all application state.
  - **Message Retry Logic:** Fixed a bug that would cause a message to become permanently unreadable if the "retry send" action was used.

## [1.5.0] - 2025-11-10

This is a quality-of-life and robustness release focused on polishing the user interface of newly implemented features and hardening the application against potential data inconsistencies.

### Changed
- **Polished Voice Message Player:** The UI for the voice message player has been significantly improved:
  - The play button now uses the main theme background color for better contrast against the message bubble.
  - A "thumb" indicator has been added to the progress bar, providing clearer visual feedback of the current playback position.
  - The overall layout and styling have been tweaked for a more refined and professional appearance.
- **Improved Error Handling for Missing Files:** All media components (`VoiceMessagePlayer`, `FileAttachment`, `LazyImage`) now provide a clear, user-friendly error message ("File not found on server.") when they fail to load a file due to a 404 error. This improves the user experience if files are cleaned up from the server.
- **Consistent Modal Language:** All text within the "Security Info" modal (`ChatInfoModal`) has been standardized to English to ensure consistency.

### Fixed
- **Incomplete Chat History:** Fixed a critical bug where opening a conversation would sometimes only show the most recent messages instead of the full history. The message loading logic now correctly fetches the complete history the first time a chat is opened.
- **Voice Message Bubble Width:** Fixed a UI bug where voice message bubbles would shrink, by enforcing a fixed, proportional width for all voice messages.
- **Voice Message Duration Bug:** Fixed a critical bug where the duration of all voice messages was incorrectly recorded as `0`. This was traced to a stale state issue within an event handler, which has been resolved by using a `useRef` hook to guarantee the correct duration is captured. This fix also corrected the progress bar indicator, which was stuck at the start.
- **File Deletion on Server:** Fixed a critical bug where deleting a message with a file attached would delete the database record but leave the physical file on the server. The backend logic now correctly reconstructs the file path and deletes the file from storage.
- **Lightbox Image Overflow:** Fixed a bug where very tall or wide images would overflow the screen in the lightbox view. The component now correctly constrains the image to the viewport while maintaining its aspect ratio and ensuring a consistent margin.
- **Reply Preview:** Fixed a bug where the reply preview UI would show incorrect information or raw encrypted text. The preview now correctly shows the sender's name and a proper summary for all message types (text, file, voice).
- **Build Failure:** Fixed a build failure caused by a dangling import to a deleted file (`sanitize.ts`) in `ChatList.tsx`.

### Reverted
- **Typing Indicator:** Reverted a change that attempted to fix the typing indicator. The implementation caused a regression in the user presence (online/offline) status and has been rolled back to restore the correct presence behavior. The typing indicator remains non-functional and is a known issue.

## [1.4.0] - 2025-11-10

This is a major security and feature release that implements a complete, end-to-end encrypted (E2EE) file sharing system, building upon the robust patterns established in previous versions. All user-uploaded content, including voice messages, images, and documents, is now fully encrypted.

### Added
- **E2EE for All File Uploads:** Extended the end-to-end encryption protocol to cover all file types. The application now follows a consistent and secure pattern for all uploads:
  1.  A one-time symmetric key is generated for the file on the client.
  2.  The file is encrypted with this key.
  3.  The file key is then encrypted with the conversation's session key.
  4.  The encrypted file is uploaded, and the encrypted file key is sent as part of the message payload.
- **E2EE Voice Messages:** Implemented a full-featured voice messaging system with E2EE.
- **Smart Media Components:** Refactored all components that handle file-based media (`VoiceMessagePlayer`, `FileAttachment`, `LazyImage`, `Lightbox`) to be "smart". They now accept the full message object, handle their own decryption logic, and manage loading/error states internally.

### Fixed
- **Critical E2EE Data Corruption Bug:** Diagnosed and fixed a persistent and elusive bug where encrypted keys were being corrupted before reaching the receiver. The root cause was traced to the database schema, where the `content` field had a default length limit that was silently truncating the long encrypted keys.
  - **Solution:** The `content` field's data type was changed to `Text` in the Prisma schema to remove the length limit. As a more robust, long-term solution, a dedicated `fileKey` field was added to the `Message` model to completely isolate file keys from the text `content` field, preventing any future conflicts.
- **UI Race Condition in Voice Recording:** Fixed a bug where the voice message duration was always recorded as `0` seconds. This was caused by a race condition where the recording timer was reset before the `onstop` event could capture its value.
- **E2EE Key Decryption Failures:**
  - Fixed a bug where the sender of a voice message or file would see a decryption error on their own optimistic message. This was resolved by making the media components "optimistic-aware" and preventing them from attempting to decrypt a raw, unencrypted key.
  - Fixed multiple instances where components would attempt to decrypt the wrong message field (e.g., `content` instead of `fileKey`).
- **Broken Lightbox:** Fixed a bug where the image lightbox failed to display images after the initial E2EE implementation. The `Lightbox` component was refactored to be "smart" and handle its own decryption.
- **UI Glitches:**
  - Fixed a bug where the raw file key (a random string) would briefly appear in the message bubble for voice messages.
  - Corrected placeholder text in reply previews for voice messages.

## [1.3.0] - 2025-11-10

This release introduces a comprehensive, professional landing page to serve as the application's public-facing "front door". It also includes numerous UI/UX enhancements and critical routing fixes.

### Added
- **New Landing Page:** Created a full-featured, animated landing page at the root (`/`) of the application, including:
  - A hero section with a call-to-action.
  - An interactive theme comparison slider to showcase light and dark modes.
  - A "Features" section with animated cards.
  - A "How It Works" section visually explaining the security flow.
  - A "Works Everywhere" section displaying the app on multiple devices.
  - A "Testimonials" section for social proof.
- **Scroll Animations:** Implemented "fade-in" and "slide-up" animations on all sections of the landing page, triggered as the user scrolls.
- **Hover Animations:** Added a more dynamic, spring-based "expand and lift" effect to the feature cards on hover.

### Changed
- **Root Routing:** The application's root route (`/`) now serves the public landing page. The main chat interface is now exclusively accessible via the `/chat` route.

### Fixed
- **Post-Login Redirect:** Fixed a critical bug where users were redirected to the landing page after logging in, registering, or restoring an account. All authentication flows now correctly redirect to `/chat`.
- **In-App Back Buttons:** Corrected multiple "back" buttons (e.g., from Settings) to navigate to `/chat` instead of the root landing page.
- **Landing Page Scrolling:** Fixed a bug where a global `overflow: hidden` style prevented the new landing page from being scrollable.
- **Component Rendering:** Fixed several React/JSX errors in the landing page that caused build failures or prevented components (like the theme slider and testimonials) from rendering correctly.

## [1.2.0] - 2025-11-08


This is a major architectural release focused on improving the long-term maintainability, stability, and performance of the application by refactoring core components and fixing critical real-time functionality bugs.

### Changed

- **Theming:**
  - Overhauled the color palettes for both light and dark modes to create a more authentic and cohesive Neumorphic aesthetic.
  - Dark mode now uses a neutral dark gray theme, removing all blue tints for a "true black" feel.
  - Light mode now uses a softer, off-gray background for both the main view and component surfaces, creating a more subtle "soft UI" effect.
  - Adjusted all shadow and border colors to complement the new palettes and enhance the 3D effect.

- **Major State Management Refactor:** The monolithic `useMessageStore` has been broken down into smaller, more focused stores (`useMessageStore`, `useMessageInputStore`, `useMessageSearchStore`) to improve separation of concerns and simplify state management.
- **Component Logic Extraction:** Refactored the `ChatList` component into a purely presentational component. All of its business logic, state selection, and side effects have been extracted into a new, dedicated `useChatList` custom hook.
- **Conversation Creation Flow:** Moved 1-on-1 conversation creation logic from a WebSocket event (`message:send`) to the `POST /api/conversations` REST endpoint, making the creation process more explicit and robust.
- **Centralized File Uploads:** Consolidated file upload logic into a new `apiUpload` helper function, removing direct `axios` usage from the stores and ensuring consistent authentication handling.

### Fixed

- **Real-time Connection for New Chats:**
  - Fixed a critical bug where the creator of a new group or 1-on-1 chat would not receive real-time messages until refreshing. The client now immediately joins the new conversation's socket room.
  - Fixed an issue where users added to a new conversation would not receive real-time updates. The client now correctly handles the `conversation:new` socket event and joins the room.
- **Server Race Condition:** Fixed a `P2003 Foreign key constraint violated` error on the server that occurred when marking a message as read too quickly. Message creation is now wrapped in a database transaction to ensure atomicity.
- **UI & Data Sync:**
  - Fixed a bug where deleting a group or conversation would not be reflected in the UI until a page refresh.
  - Fixed the user search functionality within the "Create Group" modal, which was failing due to an authentication issue.
  - Fixed a UI bug where the sender's name in group chats was invisible in dark mode by applying a theme-aware CSS filter.
- **General Stability:**
  - Fixed a bug where the initial page load would get stuck in a loading state indefinitely.
  - Resolved a Vite configuration error (`fs.allow`) that prevented `react-pdf` styles from loading.
  - Corrected multiple JavaScript `ReferenceError` and syntax errors (`Unexpected ")"`, misplaced `import`) that were introduced during the extensive refactoring process.

## [1.1.2] - 2025-11-08

This release addresses critical backend architecture and frontend user experience issues, improving application stability and robustness.

### Fixed

- **Online Status Race Condition:** Migrated the online presence tracking system from a local in-memory `Set` to a centralized Redis set. This resolves a potential race condition and ensures that the presence status and the E2EE key recovery mechanism work reliably across multiple server instances.
- **Conversation Load Error Handling:** Improved the user experience for data loading errors. The conversation list now displays a descriptive error message and a "Retry" button if conversations fail to load, allowing users to recover from network failures without a full page refresh.

## [1.1.1] - 2025-11-08

This release focuses on enhancing user experience with smoother UI transitions and a critical improvement to end-to-end encryption key recovery for offline messages.

### Added

- **Real-time E2EE Key Recovery:** Implemented a robust client-to-client key recovery mechanism via WebSocket. When a user comes online and encounters messages encrypted with a session key they don't possess (e.g., sent while offline), the client now securely requests the missing key from another online participant in the conversation.
  - Server-side Socket.IO now orchestrates key requests and fulfillment between clients.
  - Client-side Socket.IO handles emitting key requests and fulfilling requests from other clients.
  - Client-side cryptographic logic (`crypto.ts`) now non-blockingly requests keys and re-encrypts keys for other clients.
  - Client-side message store (`message.ts`) now re-decrypts messages after a missing key is successfully received.

### Changed

- **Animated Tab Indicators:** Refactored tab components (`GroupInfoPanel`, `UserInfoPanel`) to use a new `AnimatedTabs` component. The active tab indicator now slides smoothly between tabs using `framer-motion`'s `tween` transition, providing a more dynamic and responsive UI.
- **Backdrop Contrast Improvement:** Adjusted the styling of `backdrop-blur` elements to ensure better color contrast in both light and and dark themes, making blurred backgrounds darker in light mode and lighter in dark mode.

## [1.1.0] - 2025-11-08

This release introduces a complete and robust account restore flow, ensuring users can access their full, decrypted message history on a new device. It also fixes critical bugs related to the restore process.

### Added

- **Full History Sync on Restore:** When restoring an account with a recovery phrase, the application now automatically fetches, decrypts, and stores the entire history of message encryption keys. This allows users to seamlessly view their old, encrypted messages on a new device.
- **Backend Sync Endpoint:** Created a new, secure API endpoint (`/api/session-keys/sync`) to facilitate the secure transfer of historical keys to a newly restored device.

### Fixed

- **Failed Decryption on New Device:** Fixed the critical bug where messages in existing conversations would fail to decrypt after restoring an account.
- **Stuck "Syncing" Notification:** Resolved an issue where the "Syncing message keys..." notification would get stuck in a loading state. This was traced to a race condition in React's Strict Mode and has been fixed by preventing concurrent synchronization processes.

### Changed

- **Code Cleanup:** Removed an obsolete and unused encryption utility file (`web/src/utils/e2ee.ts`) to reduce technical debt and improve clarity.

## [1.0.9] - 2025-11-06

This release focuses on improving UI clarity and accessibility.

### Changed

- **Message Bubble Styling:** Adjusted the styling of self-sent messages. The chosen accent color is now applied to the message bubble's background instead of the text, improving visual distinction.

### Fixed

- **Accessibility:** 
  - Added descriptive `aria-label` attributes to all icon-only buttons across the application to improve screen reader compatibility.
  - Fixed color contrast issues in the light theme for the blue and purple accent colors to ensure text remains readable.
- **Performance:** Resolved a critical performance issue that caused high CPU usage when the onboarding modal was displayed by fixing a re-render loop.

## [1.0.8] - 2025-11-06

This release introduces a crucial onboarding experience for new users to familiarize them with the app's key security concepts.

### Added

- **New User Onboarding Tour:** Implemented a multi-step guided tour for first-time users that explains core security features like the Recovery Phrase and Safety Numbers.
- **Backend Support for Onboarding:** Added a `hasCompletedOnboarding` flag to the user model in the database and created a new API endpoint to track the tour's completion status.

### Fixed

- **Onboarding API Call:** Fixed a `TypeError` that occurred when finishing the tour by correcting the API call syntax.
- **Server-Side Rendering Issues:** Resolved an issue where a server restart was required for new backend changes to take effect.
- **Database Schema Validation:** Corrected multiple validation errors in the Prisma schema that were preventing database migrations.
- **Broken Registration Route:** Restored critical logic in the `/register` API endpoint that was accidentally deleted in a previous modification.

## [1.0.7] - 2025-11-06

This release introduces theme customization, allowing users to personalize the application by choosing their preferred accent color. It also includes several critical bug fixes for recently added features.

### Added

- **Accent Color Customization:** Users can now select their preferred accent color from a palette in the Settings page under the 'Appearance' section. The chosen color is applied across the entire application and is saved for future sessions.

### Fixed

- **Infinite Loop in Components:** Resolved a critical `Maximum update depth exceeded` error by wrapping function declarations in `useCallback` within `App.tsx` and `ChatList.tsx`, preventing infinite re-render loops.
- **Missing React Import:** Fixed a `ReferenceError` by adding a missing `useCallback` import in `App.tsx`.
- **Theme Picker UI:** Corrected a UI bug in the Settings page where color swatches were not displaying correctly. The implementation was changed to use inline styles for better reliability.

## [1.0.6] - 2025-11-06

This release upgrades the `Ctrl+K` shortcut into a full-featured Command Palette, allowing for quick execution of commands from anywhere in the application.

### Added

- **Command Palette:** Implemented a Command Palette (`Ctrl+K` or `Cmd+K`) for quick access to actions.
  - Includes initial commands: 'Settings', 'Logout', and 'New Group' (contextual).
  - Features include real-time filtering, keyboard navigation (Arrow keys & Enter), and a scalable command registration system.

### Fixed

- **Build Errors:** Resolved multiple build errors related to duplicate declarations and incorrect import paths that arose during the command palette implementation.

## [1.0.5] - 2025-11-06

This release introduces significant enhancements to file sharing, including a media gallery to browse all shared files in a conversation and rich previews for PDFs, videos, and audio files.

### Added

- **Media Gallery:** Added a 'Media' tab to the Group Info and User Info panels, allowing users to easily view all images, videos, and documents shared in a conversation.
- **Rich File Previews:** File attachments in chats now show rich previews:
  - **PDFs:** Display a preview of the first page directly in the chat.
  - **Video & Audio:** Embed a playable media player for video and audio files.

### Fixed

- **Backend API:** Fixed a 500 Internal Server Error on the new `/media` API endpoint by correcting the database query to use the proper schema fields (`fileType`, `fileUrl`, `imageUrl`).
- **PDF Preview Rendering:** Resolved a build error and a runtime warning related to the `react-pdf` library in Vite by correcting CSS import paths and self-hosting the required PDF worker script.

## [1.0.4] - 2025-11-06

This release introduces major keyboard navigation enhancements for a faster, more accessible user experience, and fixes bugs related to their implementation.

### Added

- **Keyboard Navigation:** Implemented comprehensive keyboard navigation features:
  - **Chat List Navigation:** Users can now navigate the conversation list using the `Arrow Up` and `Arrow Down` keys and open a chat by pressing `Enter`.
  - **Global Escape:** Pressing the `Escape` key now closes any open modal or side panel, providing a consistent way to exit views.
  - **Quick Search Shortcut:** Added a global `Ctrl+K` (or `Cmd+K` on Mac) shortcut to immediately focus the main search bar from anywhere in the app.

### Fixed

- **Keyboard Navigation Bugs:** Resolved several reference and syntax errors in the `ChatList` component that occurred during the implementation of keyboard navigation, ensuring the feature is stable.

## [1.0.3] - 2025-11-06

This release addresses a critical message loading bug and includes several UI refinements and fixes based on user feedback after the Neumorphic redesign.

### Changed (Improvements & Refactors)

- **Button Theme:** Reverted primary action buttons from a gradient to a solid accent color (`bg-accent`). This resolves a visual bug where the button and its text were not visible in light mode and improves consistency with the Neumorphic design.

### Fixed

- **Message Loading:** Fixed a bug where older messages would not load when opening a conversation for the first time. The app now automatically fetches additional message pages to ensure the chat history is scrollable.
- **Toggle Switch UI:** Corrected a visual glitch in the Neumorphic `ToggleSwitch` where the handle was not vertically centered within its track.

## [1.0.2] - 2025-11-06

This release completes the transition to a full Neumorphic design system, ensuring a consistent and tactile UI across the entire application. It also includes several configuration and bug fixes.

### Changed (Improvements & Refactors)

- **Neumorphic Design System:** Completed the full implementation of the Neumorphic design system, replacing all remaining standard UI elements.
- **Component Styling:** Refactored all major components to use `convex` (protruding) and `concave` (recessed) neumorphic styles, including: Modals, Panels, Cards, List Items, Message Bubbles, Buttons, and Input Fields.
- **Toggle Switch Redesign:** Rebuilt all Toggle Switches to be fully neumorphic, with a concave track and a convex handle for a more tactile feel.
- **Dark Mode Tuning:** Fine-tuned dark mode neumorphic shadows to be more subtle and visually pleasing based on user feedback.

### Fixed

- **Build Failure:** Fixed a build error caused by a missing `colors` definition in the Tailwind CSS configuration.
- **JSX Syntax Errors:** Corrected JSX parsing errors in `Register.tsx` and `Login.tsx` that prevented the application from loading.
- **Corrupted Component:** Repaired the `MessageBubble.tsx` component file which contained duplicate, conflicting code.

## [1.0.1] - 2025-11-06

This release focuses on a significant UI/UX overhaul, introducing a unique visual identity and advanced responsive layouts.

### Added (New Features)

- **"Aurora" Gradient Theme:** Implemented a distinctive Teal-to-Indigo gradient as the application's new accent color, applied to primary buttons and key UI elements.
- **"Command Center" Layout:** Introduced an adaptive three-column layout for ultrawide monitors, displaying ChatList, ChatWindow, and a contextual info panel (GroupInfoPanel or UserInfoPanel) simultaneously.
- **Hybrid Tablet Experience:** Implemented dynamic layout switching for tablets based on orientation (mobile-like in portrait, desktop-like in landscape).
- **`useOrientation` Hook:** Created a custom React hook to detect and respond to screen orientation changes.
- **`UserInfoPanel` Component:** Developed a dedicated panel to display user information in the three-column layout.
- **New `2xl` Breakpoint:** Added a `2xl` breakpoint (1920px) to Tailwind CSS for ultrawide screen optimization.

### Changed (Improvements & Refactors)

- **"Floating Glass" Sidebar:** Transformed the desktop ChatList sidebar into a semi-transparent, blurred panel (`backdrop-blur-sm`) that floats over the main content, creating a modern depth effect.
- **Dynamic Background Pattern:** Added a subtle SVG pattern to the ChatWindow background, visible through the transparent sidebar, enhancing the visual depth.
- **Unified Button Styling:** Standardized all primary buttons across the application (including Auth pages, Message Input, Create Group, Settings, and Modals) to consistently use the new "Aurora" gradient.
- **Improved Color Contrast:** Further refined color contrast ratios for secondary text in both light and dark themes to enhance accessibility.

### Fixed

- **Layout Overlap:** Resolved the issue where the floating sidebar obscured the ChatWindow content by adding responsive left padding to the main content area.
- **Solid Sidebar Background:** Fixed the bug where the ChatList sidebar appeared solid by removing an erroneous `bg-surface` class from individual chat items.
- **JSX Parsing Errors:** Corrected multiple JSX closing tag errors in `Settings.tsx`.
- **Gradient Application:** Fixed issues where the new "Aurora" gradient was not correctly applied to primary buttons on Auth pages and various in-app components.

## [1.0.0] - 2025-11-05

This is a massive overhaul release, focusing on security, new features, and a complete UI/UX redesign.

### Added (New Features)

- **Secure Device Linking:** Implemented a new, secure flow to link a new device using a QR code, eliminating the need to re-enter the recovery phrase.
- **Biometric Login:** Added support for logging in using platform authenticators (e.g., fingerprint, face ID).
- **Account Restore:** Created a new flow for restoring an account from the 24-word recovery phrase.
- **Session Management:** Added a new page where users can view and manage all their active sessions.
- **Group Chat:** Implemented full support for creating and managing group conversations.
- **E2EE & Security:**
  - Implemented the Double Ratchet algorithm for robust, self-healing E2EE session management.
  - Added Safety Number verification to allow users to confirm the identity of their contacts.
  - Strengthened the master key generation and storage process.
- **In-App Notifications:** Built a notification center and popup system for real-time, in-app alerts.
- **User Profiles:** Added user profiles with display names and descriptions.
- **Message Features:**
  - Implemented link previews for URLs shared in messages.
  - Added message search functionality.
  - Implemented read receipts and unread message counts.
  - Added an emoji picker to the message input.
  - Implemented message replies.

### Changed (Improvements & Refactors)

- **Major UI/UX Overhaul:**
  - Defined and implemented a new professional, HSL-based color palette with full light/dark mode support.
  - Redesigned all key components (`ChatList`, `MessageBubble`, `ChatWindow`, Modals) for a modern and consistent look.
  - Standardized all forms, inputs, and buttons across the application with clear `hover`, `focus`, and `disabled` states.
  - Added smooth CSS transitions and `framer-motion` animations for a more dynamic and responsive user experience (e.g., sidebar slide-in, message fade-in, list re-ordering).
  - Improved color contrast ratios for better accessibility.
- **Architecture & Performance:**
  - Migrated device linking state from server memory to **Redis** for improved scalability and reliability.
  - Refactored socket logic for more efficient real-time communication, including implicit 1-on-1 chat creation.
  - Replaced CSS-based animations with `framer-motion` for smoother, physics-based transitions.
  - Implemented `react-virtuoso` for efficient rendering of long message and conversation lists.

### Fixed

- **Server Stability:** Fixed a critical server crash that occurred during `typing` events by adding defensive checks for the user object.
- **Client-Side Errors:**
  - Resolved a `ReferenceError` in the `ChatList` component that occurred after a refactor.
  - Fixed a bug that prevented messages from being decrypted correctly on the client.
- **UI/UX Bugs:**
  - Fixed an issue where modals and dropdowns had a transparent background, adding a `backdrop-blur` effect for a modern look.
  - Corrected numerous visual and contrast issues across the app after the new theme was implemented.
- **Authentication:** Patched a token unauthorization bug.
- **General Stability:** Numerous miscellaneous bug fixes and stability improvements (as noted by commits like `stable`, `stable3`, `stable4`, `stable5`, etc.).