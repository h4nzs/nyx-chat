import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';
import HelpPage from '../react-pages/HelpPage';

export default function HelpEntry() {
  return (
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <HelpPage />
      </MemoryRouter>
    </I18nextProvider>
  );
}
