import React from 'react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import i18n from '../i18n'; // 👈 Gunakan file i18n.ts yang sudah Anda kopi

export const MarketingWrapper = ({ children }: { children: React.ReactNode }) => {
  return (
    <I18nextProvider i18n={i18n}>
      {/* MemoryRouter adalah kunci untuk menghilangkan error 'basename is null' */}
      <MemoryRouter>
        {children}
      </MemoryRouter>
    </I18nextProvider>
  );
};