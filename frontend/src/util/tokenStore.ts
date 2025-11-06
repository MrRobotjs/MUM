// Access token stored in memory only (not localStorage) per security model
// Short-lived (~10m) token minimizes blast radius if XSS occurs
let accessToken: string | null = null;

export const getAccessToken = (): string | null => accessToken;
export const setAccessToken = (token: string | null) => {
  accessToken = token || null;
};
export const clearAccessToken = () => {
  accessToken = null;
};

