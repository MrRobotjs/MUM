import { useState } from 'react';
import { accountInitial } from '../../lib/accountAvatar';

// AccountAvatar is a linked account's small round picture, or the first letter
// of its name when there is none or it fails to load. Links are re-signed on
// every read, so the picture already shown is kept and a newer link is only
// tried after it fails. Give each account its own key so this resets per account.
export function AccountAvatar({ url, name }: { url: string | null; name: string }) {
  const [shown, setShown] = useState(url);
  const [failed, setFailed] = useState(false);
  const src = shown ?? url;
  const fail = () => {
    if (url && url !== src) setShown(url);
    else setFailed(true);
  };
  return (
    <span className="account-avatar" aria-hidden="true">
      {url && src && !failed ? <img src={src} alt="" onError={fail} /> : accountInitial(name)}
    </span>
  );
}

// AvatarName is a name with its picture before it.
export function AvatarName({ url, name, children }: { url: string | null; name: string; children?: React.ReactNode }) {
  return <span className="account-avatar-name"><AccountAvatar url={url} name={name} /><span className="truncate">{children ?? name}</span></span>;
}
