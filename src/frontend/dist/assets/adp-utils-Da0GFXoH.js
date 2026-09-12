import{c}from"./index-DOhvctfz.js";/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const g=[["path",{d:"m18 15-6-6-6 6",key:"153udz"}]],C=c("chevron-up",g);/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const k=[["path",{d:"M12 15V3",key:"m9g1x1"}],["path",{d:"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4",key:"ih7n3h"}],["path",{d:"m7 10 5 5 5-5",key:"brsn70"}]],D=c("download",k);/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const P=[["path",{d:"M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z",key:"1ffxy3"}],["path",{d:"m21.854 2.147-10.94 10.939",key:"12cjpa"}]],L=c("send",P);/**
 * @license lucide-react v0.511.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const v=[["path",{d:"M3 6h18",key:"d0wm0j"}],["path",{d:"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6",key:"4alrt4"}],["path",{d:"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2",key:"v07s0e"}],["line",{x1:"10",x2:"10",y1:"11",y2:"17",key:"1uufr5"}],["line",{x1:"14",x2:"14",y1:"11",y2:"17",key:"xtxkd"}]],N=c("trash-2",v);function s(a){let t=a;if(t.includes(",")){const n=t.split(",");t=`${n[1].trim()} ${n[0].trim()}`}return t.toLowerCase().replace(/['.,-]/g,"").replace(/\s+/g," ").trim()}function x(a){const t=new Map;for(const n of a){const o=s(n.name),r=t.get(o);r?r.push(n):t.set(o,[n])}return t}function w(a,t){const n=s(a.name),o=t.get(n);if(!o||o.length===0)return null;if(o.length===1)return o[0];let r=o;if(a.position){const e=r.filter(i=>i.position.toUpperCase()===a.position.toUpperCase());if(e.length===1)return e[0];e.length>0&&(r=e)}if(a.team){const e=r.filter(i=>i.team.toUpperCase()===a.team.toUpperCase());if(e.length===1)return e[0];e.length>0&&(r=e)}return console.warn(`[ADP] Ambiguous match for "${a.name}" (${r.length} candidates) — skipping entry`),null}function $(a,t){if(!t||t.entries.length===0)return a.map(e=>({...e,adp:null}));const n=x(a),o=new Map;for(const e of t.entries){const i=w(e,n);i&&o.set(i.id,e.adp)}const r=a.map(e=>({...e,adp:o.has(e.id)?o.get(e.id):null}));for(const e of t.entries){const i=s(e.name),[p,...d]=i.split(" "),u=d.join(" ");if(p.length===1)for(const l of r){if(l.adp!==null)continue;const f=s(l.name),[h,...m]=f.split(" "),y=m.join(" ");p===h[0]&&u===y&&(l.adp=e.adp)}}return r}function z(a){return[...a].sort((t,n)=>t.adp===null&&n.adp===null?0:t.adp===null?1:n.adp===null?-1:t.adp-n.adp)}function A(a){return a.filter(t=>{const n=t;if("status"in n){const o=n.status;if(o==="Retired"||o==="Inactive")return!1}return!("active"in n&&n.active===!1)})}export{C,D,L as S,N as T,z as a,$ as e,A as g,s as n};
