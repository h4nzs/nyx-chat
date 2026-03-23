import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';
import PrivacyPage from '../react-pages/PrivacyPage';

export default function PrivacyEntry() {
  return (
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <PrivacyPage />
      </MemoryRouter>
    </I18nextProvider>
  );
}