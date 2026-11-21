import { useCallback, useEffect, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faRightToBracket } from '@fortawesome/free-solid-svg-icons';

import { getSignInSettings, saveSignInSettings, type SignInSettings } from '../../lib/serviceSignIn';
import { Alert, AlertDescription } from '../ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import { Spinner } from '@/components/ui/spinner';

export type SignInChoice = { serviceSignIn: boolean; admins: boolean };

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

// SignInSettingsFields shows both switches with their explanations, and warns
// about accounts that would lose their only way to sign in.
export const SignInSettingsFields = ({ value, saved, disabled, onChange }: { value: SignInChoice; saved: SignInSettings; disabled: boolean; onChange: (next: SignInChoice) => void }) => (
  <div className="space-y-6">
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <Switch id="service_sign_in" checked={value.serviceSignIn} disabled={disabled} onCheckedChange={(checked) => onChange({ serviceSignIn: checked, admins: checked && value.admins })} />
        <Label htmlFor="service_sign_in" className="font-normal cursor-pointer">Allow users to sign in with their media server login</Label>
      </div>
      <p className="text-xs text-muted-foreground">
        Users sign in with their Plex, Jellyfin, Emby, Audiobookshelf or Kavita login. MUM checks it with that server and keeps neither the password nor the server&apos;s token. A synced user&apos;s first sign-in creates their MUM account.
      </p>
      {saved.serviceSignIn && !value.serviceSignIn && saved.passwordlessAccounts > 0 && (
        <Alert variant="warning">
          <AlertDescription>{plural(saved.passwordlessAccounts, 'account has', 'accounts have')} no MUM password and will not be able to sign in while this is off.</AlertDescription>
        </Alert>
      )}
    </div>

    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <Switch id="service_sign_in_admins" checked={value.admins} disabled={disabled || !value.serviceSignIn} onCheckedChange={(checked) => onChange({ ...value, admins: checked })} />
        <Label htmlFor="service_sign_in_admins" className="font-normal cursor-pointer">Allow administrators to sign in this way</Label>
      </div>
      <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
        <li><strong>Off (recommended):</strong> administrators sign in with their MUM password. A leaked or reused media server password cannot open the admin side of MUM, and administrators can still sign in while a media server is down. Administrators need to keep a MUM password.</li>
        <li><strong>On:</strong> administrators can use their media server login too, which is simpler. Anyone who obtains that password, or controls that media server, can then sign in to MUM as that administrator.</li>
      </ul>
      <p className="text-xs text-muted-foreground">The owner always signs in with the MUM password.</p>
      {saved.serviceSignInAdmins && value.serviceSignIn && !value.admins && saved.passwordlessAdmins > 0 && (
        <Alert variant="warning">
          <AlertDescription>{plural(saved.passwordlessAdmins, 'administrator has', 'administrators have')} no MUM password and will not be able to sign in while this is off.</AlertDescription>
        </Alert>
      )}
    </div>
  </div>
);

export type SignInSettingsForm = ReturnType<typeof useSignInSettingsForm>;

/**
 * The sign-in settings as part of a page's form: what's saved, what's
 * chosen, whether they differ, and saving or resetting the choice. The page
 * that holds it saves it with the rest of its settings.
 */
export const useSignInSettingsForm = () => {
  const [saved, setSaved] = useState<SignInSettings | null>(null);
  const [value, setValue] = useState<SignInChoice>({ serviceSignIn: false, admins: false });
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    getSignInSettings().then((settings) => {
      if (!current) return;
      setSaved(settings);
      setValue({ serviceSignIn: settings.serviceSignIn, admins: settings.serviceSignInAdmins });
    }, (err) => { if (current) setLoadError((err as Error).message); });
    return () => { current = false; };
  }, []);

  const changed = saved !== null && (value.serviceSignIn !== saved.serviceSignIn || value.admins !== saved.serviceSignInAdmins);

  // Saves the choice; a failure is thrown to the page, which reports it.
  const save = useCallback(async () => {
    const settings = await saveSignInSettings(value.serviceSignIn, value.admins);
    setSaved(settings);
    setValue({ serviceSignIn: settings.serviceSignIn, admins: settings.serviceSignInAdmins });
  }, [value]);
  const reset = useCallback(() => {
    if (saved) setValue({ serviceSignIn: saved.serviceSignIn, admins: saved.serviceSignInAdmins });
  }, [saved]);

  return { saved, value, setValue, loadError, changed, save, reset };
};

/** The Sign-in card; its changes are saved by the page's save bar. */
export const SignInSettingsCard = ({ form, disabled }: { form: SignInSettingsForm; disabled: boolean }) => {
  const { saved, value, setValue, loadError } = form;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/20">
            <FontAwesomeIcon icon={faRightToBracket} className="size-5 text-primary" />
          </div>
          <div>
            <CardTitle className="mb-1 text-xl font-semibold">Sign-in</CardTitle>
            <CardDescription>How users and administrators sign in to MUM</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loadError ? (
          <p className="text-sm text-destructive">Failed to load sign-in settings: {loadError}</p>
        ) : saved === null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="h-4 w-4" />Loading sign-in settings...</div>
        ) : (
          <SignInSettingsFields value={value} saved={saved} disabled={disabled} onChange={setValue} />
        )}
      </CardContent>
    </Card>
  );
};

export default SignInSettingsCard;
