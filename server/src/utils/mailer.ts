// server/src/utils/mailer.ts
import nodemailer from 'nodemailer';
import { env } from '../config';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: false, // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export const sendVerificationEmail = async (to: string, code: string) => {
  await transporter.sendMail({
    from: '"Chat Lite Security" <chatlite.app@gmail.com>',
    to,
    subject: 'Your Verification Code - Chat Lite',
    html: `
      <div style="font-family: sans-serif; padding: 20px;">
        <h2>Verify your email</h2>
        <p>Your verification code is:</p>
        <h1 style="letter-spacing: 5px; background: #f4f4f4; padding: 10px; display: inline-block;">${code}</h1>
        <p>This code expires in 5 minutes.</p>
      </div>
    `,
  });
};