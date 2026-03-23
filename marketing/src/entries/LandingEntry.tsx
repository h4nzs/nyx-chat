import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';
import LandingPage from '../react-pages/LandingPage';

export default function LandingEntry() {
  return (
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>
    </I18nextProvider>
  );
}
