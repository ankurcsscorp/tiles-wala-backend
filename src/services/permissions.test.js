import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {effectivePermissions,hasPermission,validPermissionMap} from './permissions.js';
import {requirePermission} from '../middleware/permissions.js';
test('role inheritance, per-user overrides, and view/manage dependency are enforced',()=>{
 const permissions=effectivePermissions('Tile Mistire',{'sales.view':true,'sales.manage':true},{'sales.manage':false});
 assert.equal(permissions['sales.view'],true);assert.equal(permissions['sales.manage'],false);
 assert.equal(effectivePermissions('Salesperson',{}, {'sales.view':false})['sales.manage'],false);
 assert.equal(hasPermission({userType:'Admin',permissions:{}},'sales.manage'),true);
 assert.equal(validPermissionMap({'sales.view':'true'}),false);assert.equal(validPermissionMap({'users.manage':true}),false);assert.equal(validPermissionMap([]),false);
});
test('read-only users cannot mutate a module through its API',()=>{
 const user={userType:'Tile Mistire',permissions:effectivePermissions('Tile Mistire',{'sales.view':true})};
 let next=false;const res={status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
 requirePermission('sales')({user,method:'GET'},res,()=>{next=true;});assert.equal(next,true);
 requirePermission('sales')({user,method:'POST'},res,()=>assert.fail('Must not execute a mutation'));
 assert.equal(res.code,403);assert.equal(res.body.permission,'sales.manage');
});
test('browser and backend share permission definitions',async()=>{
 assert.equal(await readFile(new URL('./permissions.js',import.meta.url),'utf8'),await readFile(new URL('../../../tiles-wala-frontend/src/utils/permissions.js',import.meta.url),'utf8'));
});
