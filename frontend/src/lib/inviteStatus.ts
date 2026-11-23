type SummaryInviteStatus = {
  is_active?: boolean;
  is_paused?: boolean;
  is_expired?: boolean;
  has_reached_max_uses?: boolean;
};

export function inviteSummaryStatus(invite: SummaryInviteStatus) {
  if (invite.is_expired) return {label: 'Expired', variant: 'statusError'} as const;
  if (invite.has_reached_max_uses) return {label: 'Used up', variant: 'warning'} as const;
  if (invite.is_active === false) return {label: 'Disabled', variant: 'secondary'} as const;
  if (invite.is_paused) return {label: 'Paused', variant: 'secondary'} as const;
  return {label: 'Active', variant: 'success'} as const;
}
