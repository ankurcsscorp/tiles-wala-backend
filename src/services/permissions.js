export const USER_TYPES=['Admin','Salesperson','Tile Mistire','Plumber Mistiri'];
export const PERMISSION_MODULES=[
  ['sales','Sales & billing',true],['purchases','Purchases & receiving',true],['payments','Payments',true],
  ['returns','Sales & purchase returns',true],['inventory','Inventory & adjustments',true],['transfers','Stock transfers',true],
  ['customers','Customers & ledgers',true],['suppliers','Suppliers & ledgers',true],['reports','Financial reports',false],
  ['dashboard','Dashboard',false],['products','Product management',true],['invoice_settings','Invoice settings',true],
  ['enquiries','Enquiry management',true],['collections','Collection management',true],['bonus','Own sales bonus records',false],
  ['bonus_cost','Bonus cost and profit details',false],
].map(([key,label,manage])=>({key,label,manage}));
export const PERMISSION_KEYS=PERMISSION_MODULES.flatMap(m=>[`${m.key}.view`,...(m.manage?[`${m.key}.manage`]:[])]);
const staff=new Set(['sales','purchases','payments','returns','inventory','transfers','customers','suppliers','reports','dashboard','invoice_settings','enquiries','bonus']);
export const defaultPermissions=type=>Object.fromEntries(PERMISSION_KEYS.map(key=>[key,
  String(type).toLowerCase()==='admin'||(type==='Salesperson'&&staff.has(key.split('.')[0]))||(type==='Tile Mistire'&&key==='bonus.view')
]));
export function effectivePermissions(type,role={},overrides={}){
  if(String(type).toLowerCase()==='admin')return defaultPermissions('Admin');
  const result={...defaultPermissions(type),...role,...overrides};
  for(const m of PERMISSION_MODULES)if(!result[`${m.key}.view`])result[`${m.key}.manage`]=false;
  return Object.fromEntries(PERMISSION_KEYS.map(key=>[key,result[key]===true]));
}
export const validPermissionMap=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.entries(value).every(([key,v])=>PERMISSION_KEYS.includes(key)&&typeof v==='boolean');
export const hasPermission=(user,key)=>String(user?.userType).toLowerCase()==='admin'||(user?.permissions??defaultPermissions(user?.userType))[key]===true;
