// The OAuth client of the web page (Google Cloud Console → APIs & Services → Credentials →
// OAuth client ID, type "Web application", in the same project as the Android app). A client ID
// is public by design; it only works from the origins listed for it in the console.
export const CONFIG = {
  clientId: '96307000802-6be5ro2agksi4ueihquc2bldtna16vp6.apps.googleusercontent.com',
  // The server function that downloads invoices sent as links in emails (cloud/link-fetcher).
  linkFetcher: 'https://fetch-invoice-link-d2s4b6sxma-zf.a.run.app',
};
