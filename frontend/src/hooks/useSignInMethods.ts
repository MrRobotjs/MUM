import { useEffect, useState } from 'react';
import { getSignInMethods, type SignInMethods } from '../lib/serviceSignIn';

const none: SignInMethods = { serviceSignIn: false, plex: false, servers: [] };

// useSignInMethods reads which media server logins the login page may offer.
// Until the answer arrives, or if it cannot be read, only the MUM password
// form is offered.
export const useSignInMethods = (): SignInMethods => {
  const [methods, setMethods] = useState<SignInMethods>(none);
  useEffect(() => {
    let current = true;
    getSignInMethods().then((value) => { if (current) setMethods(value); }, () => { if (current) setMethods(none); });
    return () => { current = false; };
  }, []);
  return methods;
};
