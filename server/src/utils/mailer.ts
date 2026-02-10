// server/src/utils/mailer.ts
import { Resend } from 'resend'

// Inisialisasi Resend (Pastikan RESEND_API_KEY ada di .env)
const resend = new Resend(process.env.RESEND_API_KEY)

// Template HTML yang Elegan & Profesional
const getHtmlTemplate = (code: string) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background-color: #f9fafb;
      margin: 0;
      padding: 0;
      color: #374151;
    }
    .container {
      max-width: 480px;
      margin: 40px auto;
      background-color: #ffffff;
      border-radius: 12px;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
      overflow: hidden;
      border: 1px solid #e5e7eb;
    }
    .header {
      background-color: #111827; /* Dark elegant header */
      padding: 24px;
      text-align: center;
    }
    .header h1 {
      color: #ffffff;
      margin: 0;
      font-size: 20px;
      font-weight: 600;
      letter-spacing: 0.5px;
    }
    .content {
      padding: 32px 24px;
      text-align: center;
    }
    .content h2 {
      margin-top: 0;
      font-size: 18px;
      font-weight: 600;
      color: #1f2937;
    }
    .content p {
      font-size: 15px;
      line-height: 1.6;
      margin-bottom: 24px;
      color: #4b5563;
    }
    .code-box {
      background-color: #f3f4f6;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 16px;
      margin: 24px 0;
      text-align: center;
    }
    .code {
      font-family: 'Courier New', Courier, monospace;
      font-size: 32px;
      font-weight: 700;
      letter-spacing: 8px;
      color: #111827;
      margin: 0;
      display: inline-block;
    }
    .footer {
      background-color: #f9fafb;
      padding: 16px 24px;
      text-align: center;
      border-top: 1px solid #e5e7eb;
      font-size: 12px;
      color: #9ca3af;
    }
    .warning {
      font-size: 13px;
      color: #ef4444;
      margin-top: 16px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>NYX Secure Chat</h1>
    </div>
    <div class="content">
      <h2>Verify your identity</h2>
      <p>Someone requested to sign up to your NYX account. Enter the following code to complete the verification process.</p>
      
      <div class="code-box">
        <span class="code">${code}</span>
      </div>
      
      <p>This code will expire in <strong>5 minutes</strong>.</p>
      
      <p class="warning">If you didn't request this code, please ignore this email. Your account remains secure.</p>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} NYX App. All rights reserved.<br>
      Secure End-to-End Encrypted Messaging.
    </div>
  </div>
</body>
</html>
`

export const sendVerificationEmail = async (to: string, code: string) => {
  try {
    // Gunakan domain yang sudah diverifikasi di Resend
    // Format: "Nama Pengirim <email@domain-verified.com>"
    const fromEmail = 'NYX Security <security@nyx-app.my.id>'

    const { error } = await resend.emails.send({
      from: fromEmail,
      to: [to], // Resend butuh array string
      subject: `Your Verification Code: ${code}`,
      html: getHtmlTemplate(code)
    })

    if (error) {
      console.error('❌ Resend API Error:', error)
      return false
    }

    return true
  } catch (err) {
    console.error('❌ Failed to send email:', err)
    return false
  }
}
