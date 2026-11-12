import {useAuth} from '../contexts/AuthContext';
import {useActivityHistory,useActivityCurrent} from './useActivityHistory';

export function useIdentityHistory(target?:string,enabled=true){
  const {isAdministrator}=useAuth();
  return useActivityHistory(isAdministrator?'all':'own',undefined,target,enabled&&Boolean(target));
}

export function useIdentityCurrent(target?:string,enabled=true){
 const {isAdministrator}=useAuth();
 return useActivityCurrent(isAdministrator?'all':'own',undefined,target,enabled&&Boolean(target));
}
