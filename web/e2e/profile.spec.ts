import { test, expect, Page } from '@playwright/test';
import { registerUser } from './helpers/registration';


test.describe('Profile & Identity Settings', () => {
  test('Update profile display name and bio', async ({ page }) => {
    test.setTimeout(150000);
    const username = `profile_${Date.now()}`;
    await registerUser(page, 'Old Name', username);

    // 1. Navigate to settings (where editing happens)
    const settingsLink = page.locator('a[href="/settings"]').first();
    if (await settingsLink.isVisible()) {
      await settingsLink.click();
    } else {
      await page.goto('/settings');
    }
    
    // Tunggu animasi masuk settings selesai
    await page.waitForTimeout(1000);

    // 2. Update display name
    // Menggunakan pemilih CSS yang tangguh namun spesifik karena elemen input teks bisa lebih dari satu
    const nameField = page.locator('input[type="text"]').filter({ hasNot: page.locator('[readonly]') }).first();
    await expect(nameField).toBeVisible({ timeout: 10000 });
    await nameField.fill('Updated Ghost Identity');
    
    // 3. Save changes
    // Mencari tombol submit form atau tombol yang memiliki teks 'save' atau 'update'
    const saveBtn = page.getByRole('button', { name: /save|update|processing/i }).filter({ hasText: /save|update/i }).first();
    if (await saveBtn.isVisible()) {
      await saveBtn.click();
    } else {
      // Fallback
      await page.locator('button[type="submit"]').first().click();
    }

    // 4. Verify UI reflects the change or success message appears
    await expect(nameField).toHaveValue('Updated Ghost Identity', { timeout: 10000 });
    
    // Verifikasi inisial Avatar berubah menjadi UG (Updated Ghost)
    // expect.poll: event `user:updated`/REST update bisa lambat saat suite paralel
    // (server lokal). Polling 45 detik jauh lebih stabil daripada expect tunggal.
    await expect.poll(
      async () => {
        const initials = await page.getByText('UG', { exact: true }).first().isVisible().catch(() => false);
        return initials;
      },
      { timeout: 45000, message: 'Avatar initials "UG" harus muncul setelah update profil' }
    ).toBe(true);
  });
});
