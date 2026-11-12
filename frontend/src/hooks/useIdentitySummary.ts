import {useAuth} from '../contexts/AuthContext';
import {useStreamingSummary} from './useStreamingSummary';
export function useIdentitySummary(target?:string,enabled=true){
 const {isAdministrator}=useAuth();
 return useStreamingSummary(isAdministrator?'all':'own',enabled&&Boolean(target),target);
}
