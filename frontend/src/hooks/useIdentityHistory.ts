import {useAuth} from '../contexts/AuthContext';
import {useActivityCurrent} from './useActivityHistory';

// The user page's History tab reads the combined timeline (useIdentityTimeline).
export function useIdentityCurrent(target?:string,enabled=true){
 const {isAdministrator}=useAuth();
 return useActivityCurrent(isAdministrator?'all':'own',undefined,target,enabled&&Boolean(target));
}
