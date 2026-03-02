import { Helmet } from 'react-helmet-async';

interface SEOProps {
  title: string;
  description: string;
  canonicalUrl: string;
  schemaMarkup?: string;
}

export default function SEO({ title, description, canonicalUrl, schemaMarkup }: SEOProps) {
  const fullTitle = title === 'NYX' ? 'NYX \u2014 Secure & Private Messaging' : `${title} | NYX`;
  const domain = 'https://nyx-app.my.id';
  const fullCanonical = `${domain}${canonicalUrl}`;
  const defaultImage = `${domain}/normal-desktop-dark.png`;

  return (
    <Helmet>
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={fullCanonical} />

      {/* Open Graph */}
      <meta property="og:type" content="website" />
      <meta property="og:url" content={fullCanonical} />
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:image" content={defaultImage} />

      {/* Twitter */}
      <meta property="twitter:card" content="summary_large_image" />
      <meta property="twitter:url" content={fullCanonical} />
      <meta property="twitter:title" content={fullTitle} />
      <meta property="twitter:description" content={description} />
      <meta property="twitter:image" content={defaultImage} />

      {/* AI / GEO Directives */}
      <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1" />

      {/* JSON-LD Schema */}
      {schemaMarkup && (
        <script type="application/ld+json">{schemaMarkup}</script>
      )}
    </Helmet>
  );
}