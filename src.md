Plan for Markdown Message Formatting Implementation

  1. Frontend Changes:
   - Message Display: Create a MarkdownMessage component that uses a library like
     react-markdown to render formatted text
   - Message Input: Enhance the message input field with formatting indicators (showing
     text as bold, etc.) or a toolbar for formatting
   - Security: Implement proper sanitization to prevent XSS attacks when rendering Markdown

  2. Backend Changes:
   - Message Storage: Messages will continue to be stored as plain text in the database
   - API Updates: No changes needed to API endpoints, as formatting is handled client-side

  3. Technical Approach:
   - Use a Markdown library like react-markdown or marked for rendering
   - Ensure basic formatting support: bold, italic, strikethrough, code blocks, and code
     snippets
   - Apply sanitization using DOMPurify to prevent XSS attacks

  4. Integration Points:
   - Update MessageItem component to use the new Markdown renderer
   - Update the message display logic in ChatWindow
   - Ensure the formatting works in both sent and received messages

  This approach ensures that the Markdown formatting is implemented securely and works
  consistently across the application without requiring changes to the database schema or
  API structure.

  - Maybe Mute/Unmute or other notification settings
  - Maybe View Info or Settings
