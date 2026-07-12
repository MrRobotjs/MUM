export const buildInviteShareUrl = (token: string, customPath?: string | null): string => {
  const segment = encodeURIComponent(customPath || token);
  return `${window.location.origin}/invite/${segment}`;
};

export const copyInviteShareUrl = async (
  token: string,
  customPath?: string | null,
): Promise<void> => {
  await navigator.clipboard.writeText(buildInviteShareUrl(token, customPath));
};
