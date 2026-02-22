# Privacy Hardening: Blind Attachments & Encrypted Reactions

## Goal
Eliminate metadata leakage by removing file attributes and reaction tables from the database, moving them into the encrypted message payload.

## Tasks

### Phase 1: Blind Attachments
- [ ] **Prisma Schema Update**: Remove `fileUrl`, `fileName`, `fileType`, `fileSize`, `duration` from `Message` model. Keep `fileKey` (encrypted) or better, merge it into a generic `metadata` blob or just rely on `content`. -> Verify: `npx prisma migrate dev`.
- [ ] **API Update (`uploads.ts`)**: Stop saving file metadata to DB. Only return the R2 Key/URL to the client. -> Verify: DB row for message has null/empty file fields.
- [ ] **Frontend Logic (`message.ts`)**: 
    -   Pack file metadata (`url`, `name`, `size`, `type`, `key`) into a JSON object.
    -   Encrypt this JSON as the message `content`.
    -   Update `sendMessage` to send this encrypted blob.
- [ ] **Frontend Rendering (`MessageItem.tsx`)**: Update decryption logic to parse the JSON and pass attributes to `FileAttachment` / `Image`. -> Verify: Files still render but data comes from inside the encrypted envelope.

### Phase 2: Reactions as Messages
- [ ] **Prisma Schema Update**: Remove `MessageReaction` and `MessageStatus` (optional, keep status for now for delivery reports?) tables. Let's start with Reactions. Remove `MessageReaction`.
- [ ] **Frontend Store (`message.ts`)**:
    -   Create `sendReaction(targetMsgId, emoji)`: Sends a new `Message` with specific structure (e.g. `{ type: "reaction", target: "...", emoji: "..." }`) encrypted.
    -   Update `addIncomingMessage`: Detect if message is a "Reaction Payload". If yes, update the *target message's* local state instead of showing a new bubble.
- [ ] **UI Update**: Ensure reactions are optimistically applied and rendered from this new event stream.

## Done When
- [ ] Database schema no longer has `fileName`, `fileType`, `MessageReaction`.
- [ ] Uploading a file still works UI-wise, but server sees opaque ciphertext.
- [ ] Reacting to a message still shows the emoji, but server sees a new opaque message added to the conversation.

## Notes
- **Breaking Change**: Old file messages will likely break (metadata lost) unless we migrate them to `content`. Given "Soft Launch" status, we might just drop them or accept they are broken.
- **Search**: Server-side media gallery will break. We need to disable/remove the "Media" tab fetching from API.
