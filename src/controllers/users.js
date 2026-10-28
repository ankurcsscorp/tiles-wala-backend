import {connection} from '../../connection.js';
import {USER_TYPES,PERMISSION_MODULES,effectivePermissions,defaultPermissions,validPermissionMap} from '../services/permissions.js';
const admin=user=>user?.userType?.toLowerCase()==='admin';
const fields=`u.id,u.name,u.mobile,u.user_type,u.area_location,u.is_active,u.permission_overrides,u.created_at,u.updated_at,
 COALESCE(r.permissions,'{}'::jsonb) AS role_permissions`;
export const publicManagedUser=row=>({id:row.id,name:row.name,mobile:row.mobile,userType:row.user_type,areaLocation:row.area_location,isActive:row.is_active!==false,createdAt:row.created_at,
 permissionOverrides:row.permission_overrides||{},rolePermissions:effectivePermissions(row.user_type,row.role_permissions),permissions:effectivePermissions(row.user_type,row.role_permissions,row.permission_overrides)});
export async function currentUser(req,res){res.json({user:req.user});}
export async function listManagedUsers(req,res){
 if(!admin(req.user))return res.status(403).json({message:'Administrator access is required'});
 const q=String(req.query.q||'').trim(),limit=25,offset=Math.max(0,Number.parseInt(req.query.offset)||0);
 if(q.length>100)return res.status(400).json({message:'Search must be 100 characters or fewer'});
 try{
  const where="WHERE (u.name ILIKE $1 OR u.mobile ILIKE $1)";
  const [rows,count]=await Promise.all([connection.query(`SELECT ${fields} FROM users u LEFT JOIN role_permission_settings r ON r.user_type=u.user_type ${where} ORDER BY u.name,u.id LIMIT $2 OFFSET $3`,[`%${q}%`,limit,offset]),connection.query(`SELECT count(*)::int total FROM users u ${where}`,[`%${q}%`])]);
  res.json({items:rows.rows.map(publicManagedUser),total:count.rows[0].total,limit,offset});
 }catch(e){console.error('List users',e.message);res.status(500).json({message:'Unable to load users'});}
}
export async function permissionCatalog(req,res){
 try{const rows=await connection.query('SELECT user_type,permissions FROM role_permission_settings');
  res.json({modules:PERMISSION_MODULES,roles:USER_TYPES.map(userType=>({userType,permissions:effectivePermissions(userType,rows.rows.find(r=>r.user_type===userType)?.permissions),defaults:defaultPermissions(userType)}))});
 }catch(e){res.status(500).json({message:'Unable to load permission defaults'});}
}
async function accessTransaction(req,res,work){
 if(!admin(req.user))return res.status(403).json({message:'Administrator access is required'});
 const c=await connection.connect();
 try{await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtextextended('user-access-management',0))");
  const actor=await c.query('SELECT user_type,is_active FROM users WHERE id=$1 FOR UPDATE',[req.user.id]);
  if(!actor.rows[0]?.is_active||actor.rows[0].user_type!=='Admin'){await c.query('ROLLBACK');return res.status(403).json({message:'Active administrator access is required'});}
  const result=await work(c);await c.query('COMMIT');res.json(result);
 }catch(e){await c.query('ROLLBACK').catch(()=>{});if(e.status)return res.status(e.status).json({message:e.message});console.error('Update user access',e.message);res.status(500).json({message:'Unable to save user access'});}finally{c.release();}
}
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
export async function updateManagedUser(req,res){
 const {userType,isActive,permissionOverrides}=req.body||{};
 if(!/^\d+$/.test(req.params.id)||!USER_TYPES.includes(userType)||typeof isActive!=='boolean'||!validPermissionMap(permissionOverrides))return res.status(400).json({message:'Provide a valid user type, account status, and permission overrides'});
 return accessTransaction(req,res,async c=>{
  const previous=await c.query('SELECT id,user_type,is_active,permission_overrides FROM users WHERE id=$1 FOR UPDATE',[req.params.id]);
  if(!previous.rowCount)fail(404,'User not found');
  if(String(req.user.id)===String(req.params.id)&&(userType!=='Admin'||!isActive))fail(409,'You cannot disable or remove your own administrator access.');
  await c.query('UPDATE users SET user_type=$2,is_active=$3,permission_overrides=$4,updated_at=now() WHERE id=$1',[req.params.id,userType,isActive,permissionOverrides]);
  const updated=await c.query(`SELECT ${fields} FROM users u LEFT JOIN role_permission_settings r ON r.user_type=u.user_type WHERE u.id=$1`,[req.params.id]);
  await c.query("INSERT INTO audit_logs(user_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,'users.access.updated','user',$2,$3,$4)",[req.user.id,req.params.id,previous.rows[0],{userType,isActive,permissionOverrides}]);
  return publicManagedUser(updated.rows[0]);
 });
}
export async function updateRolePermissions(req,res){
 const {permissions}=req.body||{};
 if(!USER_TYPES.includes(req.params.userType)||req.params.userType==='Admin'||!validPermissionMap(permissions))return res.status(400).json({message:'Choose a non-admin user type and valid permissions'});
 return accessTransaction(req,res,async c=>{
  const previous=await c.query('SELECT permissions FROM role_permission_settings WHERE user_type=$1',[req.params.userType]);
  await c.query('INSERT INTO role_permission_settings(user_type,permissions,updated_by) VALUES($1,$2,$3) ON CONFLICT(user_type) DO UPDATE SET permissions=$2,updated_by=$3,updated_at=now()',[req.params.userType,permissions,req.user.id]);
  await c.query("INSERT INTO audit_logs(user_id,action,entity_type,before_data,after_data) VALUES($1,'users.role_permissions.updated','user_type',$2,$3)",[req.user.id,{userType:req.params.userType,permissions:previous.rows[0]?.permissions||{}},{userType:req.params.userType,permissions}]);
  return {userType:req.params.userType,permissions:effectivePermissions(req.params.userType,permissions)};
 });
}
