import {hasPermission} from '../services/permissions.js';
export const requirePermission=(module,action)=>(req,res,next)=>{
  if(!req.user)return res.status(401).json({message:'Authentication is required'});
  const key=`${module}.${action||(req.method==='GET'?'view':'manage')}`;
  if(!hasPermission(req.user,key))return res.status(403).json({code:'PERMISSION_DENIED',permission:key,message:`You do not have ${action|| (req.method==='GET'?'view':'manage')} permission for ${module.replaceAll('_',' ')}.`});
  return next();
};
// Lookup data is also needed by authorized entry forms, without granting master editing.
export const requireAnyPermission=(...keys)=>(req,res,next)=>keys.some(key=>hasPermission(req.user,key))?next():res.status(403).json({code:'PERMISSION_DENIED',message:'You do not have permission to access this data.'});
