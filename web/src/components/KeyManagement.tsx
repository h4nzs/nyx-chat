import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslation } from 'react-i18next';

const KeyManagement = () => {
  const { t } = useTranslation('settings');
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('encryption_key_management', 'Encryption Key Management')}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          {t('encryption_key_managed_automatically', 'Encryption keys are now generated and managed automatically for each user session. Manual key configuration is no longer required.')}
        </p>
      </CardContent>
    </Card>
  );
};

export default KeyManagement;