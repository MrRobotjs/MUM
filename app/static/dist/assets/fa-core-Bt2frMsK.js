function xt(t,e){(e==null||e>t.length)&&(e=t.length);for(var a=0,r=Array(e);a<e;a++)r[a]=t[a];return r}function Ia(t){if(Array.isArray(t))return t}function Ea(t){if(Array.isArray(t))return xt(t)}function Fa(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}function Oa(t,e){for(var a=0;a<e.length;a++){var r=e[a];r.enumerable=r.enumerable||!1,r.configurable=!0,"value"in r&&(r.writable=!0),Object.defineProperty(t,Se(r.key),r)}}function Ca(t,e,a){return e&&Oa(t.prototype,e),Object.defineProperty(t,"prototype",{writable:!1}),t}function tt(t,e){var a=typeof Symbol<"u"&&t[Symbol.iterator]||t["@@iterator"];if(!a){if(Array.isArray(t)||(a=$t(t))||e){a&&(t=a);var r=0,n=function(){};return{s:n,n:function(){return r>=t.length?{done:!0}:{done:!1,value:t[r++]}},e:function(l){throw l},f:n}}throw new TypeError(`Invalid attempt to iterate non-iterable instance.
In order to be iterable, non-array objects must have a [Symbol.iterator]() method.`)}var o,i=!0,s=!1;return{s:function(){a=a.call(t)},n:function(){var l=a.next();return i=l.done,l},e:function(l){s=!0,o=l},f:function(){try{i||a.return==null||a.return()}finally{if(s)throw o}}}}function v(t,e,a){return(e=Se(e))in t?Object.defineProperty(t,e,{value:a,enumerable:!0,configurable:!0,writable:!0}):t[e]=a,t}function Na(t){if(typeof Symbol<"u"&&t[Symbol.iterator]!=null||t["@@iterator"]!=null)return Array.from(t)}function ja(t,e){var a=t==null?null:typeof Symbol<"u"&&t[Symbol.iterator]||t["@@iterator"];if(a!=null){var r,n,o,i,s=[],l=!0,u=!1;try{if(o=(a=a.call(t)).next,e===0){if(Object(a)!==a)return;l=!1}else for(;!(l=(r=o.call(a)).done)&&(s.push(r.value),s.length!==e);l=!0);}catch(m){u=!0,n=m}finally{try{if(!l&&a.return!=null&&(i=a.return(),Object(i)!==i))return}finally{if(u)throw n}}return s}}function Ta(){throw new TypeError(`Invalid attempt to destructure non-iterable instance.
In order to be iterable, non-array objects must have a [Symbol.iterator]() method.`)}function _a(){throw new TypeError(`Invalid attempt to spread non-iterable instance.
In order to be iterable, non-array objects must have a [Symbol.iterator]() method.`)}function Bt(t,e){var a=Object.keys(t);if(Object.getOwnPropertySymbols){var r=Object.getOwnPropertySymbols(t);e&&(r=r.filter(function(n){return Object.getOwnPropertyDescriptor(t,n).enumerable})),a.push.apply(a,r)}return a}function f(t){for(var e=1;e<arguments.length;e++){var a=arguments[e]!=null?arguments[e]:{};e%2?Bt(Object(a),!0).forEach(function(r){v(t,r,a[r])}):Object.getOwnPropertyDescriptors?Object.defineProperties(t,Object.getOwnPropertyDescriptors(a)):Bt(Object(a)).forEach(function(r){Object.defineProperty(t,r,Object.getOwnPropertyDescriptor(a,r))})}return t}function ot(t,e){return Ia(t)||ja(t,e)||$t(t,e)||Ta()}function E(t){return Ea(t)||Na(t)||$t(t)||_a()}function $a(t,e){if(typeof t!="object"||!t)return t;var a=t[Symbol.toPrimitive];if(a!==void 0){var r=a.call(t,e);if(typeof r!="object")return r;throw new TypeError("@@toPrimitive must return a primitive value.")}return(e==="string"?String:Number)(t)}function Se(t){var e=$a(t,"string");return typeof e=="symbol"?e:e+""}function rt(t){"@babel/helpers - typeof";return rt=typeof Symbol=="function"&&typeof Symbol.iterator=="symbol"?function(e){return typeof e}:function(e){return e&&typeof Symbol=="function"&&e.constructor===Symbol&&e!==Symbol.prototype?"symbol":typeof e},rt(t)}function $t(t,e){if(t){if(typeof t=="string")return xt(t,e);var a={}.toString.call(t).slice(8,-1);return a==="Object"&&t.constructor&&(a=t.constructor.name),a==="Map"||a==="Set"?Array.from(t):a==="Arguments"||/^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(a)?xt(t,e):void 0}}var Vt=function(){},Mt={},ke={},Pe=null,Ie={mark:Vt,measure:Vt};try{typeof window<"u"&&(Mt=window),typeof document<"u"&&(ke=document),typeof MutationObserver<"u"&&(Pe=MutationObserver),typeof performance<"u"&&(Ie=performance)}catch{}var Ma=Mt.navigator||{},Jt=Ma.userAgent,Kt=Jt===void 0?"":Jt,T=Mt,p=ke,qt=Pe,Q=Ie;T.document;var j=!!p.documentElement&&!!p.head&&typeof p.addEventListener=="function"&&typeof p.createElement=="function",Ee=~Kt.indexOf("MSIE")||~Kt.indexOf("Trident/"),mt,Da=/fa(k|kd|s|r|l|t|d|dr|dl|dt|b|slr|slpr|wsb|tl|ns|nds|es|jr|jfr|jdr|usb|ufsb|udsb|cr|ss|sr|sl|st|sds|sdr|sdl|sdt)?[\-\ ]/,La=/Font ?Awesome ?([567 ]*)(Solid|Regular|Light|Thin|Duotone|Brands|Free|Pro|Sharp Duotone|Sharp|Kit|Notdog Duo|Notdog|Chisel|Etch|Thumbprint|Jelly Fill|Jelly Duo|Jelly|Utility|Utility Fill|Utility Duo|Slab Press|Slab|Whiteboard)?.*/i,Fe={classic:{fa:"solid",fas:"solid","fa-solid":"solid",far:"regular","fa-regular":"regular",fal:"light","fa-light":"light",fat:"thin","fa-thin":"thin",fab:"brands","fa-brands":"brands"},duotone:{fa:"solid",fad:"solid","fa-solid":"solid","fa-duotone":"solid",fadr:"regular","fa-regular":"regular",fadl:"light","fa-light":"light",fadt:"thin","fa-thin":"thin"},sharp:{fa:"solid",fass:"solid","fa-solid":"solid",fasr:"regular","fa-regular":"regular",fasl:"light","fa-light":"light",fast:"thin","fa-thin":"thin"},"sharp-duotone":{fa:"solid",fasds:"solid","fa-solid":"solid",fasdr:"regular","fa-regular":"regular",fasdl:"light","fa-light":"light",fasdt:"thin","fa-thin":"thin"},slab:{"fa-regular":"regular",faslr:"regular"},"slab-press":{"fa-regular":"regular",faslpr:"regular"},thumbprint:{"fa-light":"light",fatl:"light"},whiteboard:{"fa-semibold":"semibold",fawsb:"semibold"},notdog:{"fa-solid":"solid",fans:"solid"},"notdog-duo":{"fa-solid":"solid",fands:"solid"},etch:{"fa-solid":"solid",faes:"solid"},jelly:{"fa-regular":"regular",fajr:"regular"},"jelly-fill":{"fa-regular":"regular",fajfr:"regular"},"jelly-duo":{"fa-regular":"regular",fajdr:"regular"},chisel:{"fa-regular":"regular",facr:"regular"},utility:{"fa-semibold":"semibold",fausb:"semibold"},"utility-duo":{"fa-semibold":"semibold",faudsb:"semibold"},"utility-fill":{"fa-semibold":"semibold",faufsb:"semibold"}},Ra={GROUP:"duotone-group",PRIMARY:"primary",SECONDARY:"secondary"},Oe=["fa-classic","fa-duotone","fa-sharp","fa-sharp-duotone","fa-thumbprint","fa-whiteboard","fa-notdog","fa-notdog-duo","fa-chisel","fa-etch","fa-jelly","fa-jelly-fill","fa-jelly-duo","fa-slab","fa-slab-press","fa-utility","fa-utility-duo","fa-utility-fill"],w="classic",J="duotone",Ce="sharp",Ne="sharp-duotone",je="chisel",Te="etch",_e="jelly",$e="jelly-duo",Me="jelly-fill",De="notdog",Le="notdog-duo",Re="slab",ze="slab-press",We="thumbprint",Ue="utility",Ye="utility-duo",He="utility-fill",Ge="whiteboard",za="Classic",Wa="Duotone",Ua="Sharp",Ya="Sharp Duotone",Ha="Chisel",Ga="Etch",Xa="Jelly",Ba="Jelly Duo",Va="Jelly Fill",Ja="Notdog",Ka="Notdog Duo",qa="Slab",Qa="Slab Press",Za="Thumbprint",tr="Utility",er="Utility Duo",ar="Utility Fill",rr="Whiteboard",Xe=[w,J,Ce,Ne,je,Te,_e,$e,Me,De,Le,Re,ze,We,Ue,Ye,He,Ge];mt={},v(v(v(v(v(v(v(v(v(v(mt,w,za),J,Wa),Ce,Ua),Ne,Ya),je,Ha),Te,Ga),_e,Xa),$e,Ba),Me,Va),De,Ja),v(v(v(v(v(v(v(v(mt,Le,Ka),Re,qa),ze,Qa),We,Za),Ue,tr),Ye,er),He,ar),Ge,rr);var nr={classic:{900:"fas",400:"far",normal:"far",300:"fal",100:"fat"},duotone:{900:"fad",400:"fadr",300:"fadl",100:"fadt"},sharp:{900:"fass",400:"fasr",300:"fasl",100:"fast"},"sharp-duotone":{900:"fasds",400:"fasdr",300:"fasdl",100:"fasdt"},slab:{400:"faslr"},"slab-press":{400:"faslpr"},whiteboard:{600:"fawsb"},thumbprint:{300:"fatl"},notdog:{900:"fans"},"notdog-duo":{900:"fands"},etch:{900:"faes"},chisel:{400:"facr"},jelly:{400:"fajr"},"jelly-fill":{400:"fajfr"},"jelly-duo":{400:"fajdr"},utility:{600:"fausb"},"utility-duo":{600:"faudsb"},"utility-fill":{600:"faufsb"}},ir={"Font Awesome 7 Free":{900:"fas",400:"far"},"Font Awesome 7 Pro":{900:"fas",400:"far",normal:"far",300:"fal",100:"fat"},"Font Awesome 7 Brands":{400:"fab",normal:"fab"},"Font Awesome 7 Duotone":{900:"fad",400:"fadr",normal:"fadr",300:"fadl",100:"fadt"},"Font Awesome 7 Sharp":{900:"fass",400:"fasr",normal:"fasr",300:"fasl",100:"fast"},"Font Awesome 7 Sharp Duotone":{900:"fasds",400:"fasdr",normal:"fasdr",300:"fasdl",100:"fasdt"},"Font Awesome 7 Jelly":{400:"fajr",normal:"fajr"},"Font Awesome 7 Jelly Fill":{400:"fajfr",normal:"fajfr"},"Font Awesome 7 Jelly Duo":{400:"fajdr",normal:"fajdr"},"Font Awesome 7 Slab":{400:"faslr",normal:"faslr"},"Font Awesome 7 Slab Press":{400:"faslpr",normal:"faslpr"},"Font Awesome 7 Thumbprint":{300:"fatl",normal:"fatl"},"Font Awesome 7 Notdog":{900:"fans",normal:"fans"},"Font Awesome 7 Notdog Duo":{900:"fands",normal:"fands"},"Font Awesome 7 Etch":{900:"faes",normal:"faes"},"Font Awesome 7 Chisel":{400:"facr",normal:"facr"},"Font Awesome 7 Whiteboard":{600:"fawsb",normal:"fawsb"},"Font Awesome 7 Utility":{600:"fausb",normal:"fausb"},"Font Awesome 7 Utility Duo":{600:"faudsb",normal:"faudsb"},"Font Awesome 7 Utility Fill":{600:"faufsb",normal:"faufsb"}},or=new Map([["classic",{defaultShortPrefixId:"fas",defaultStyleId:"solid",styleIds:["solid","regular","light","thin","brands"],futureStyleIds:[],defaultFontWeight:900}],["duotone",{defaultShortPrefixId:"fad",defaultStyleId:"solid",styleIds:["solid","regular","light","thin"],futureStyleIds:[],defaultFontWeight:900}],["sharp",{defaultShortPrefixId:"fass",defaultStyleId:"solid",styleIds:["solid","regular","light","thin"],futureStyleIds:[],defaultFontWeight:900}],["sharp-duotone",{defaultShortPrefixId:"fasds",defaultStyleId:"solid",styleIds:["solid","regular","light","thin"],futureStyleIds:[],defaultFontWeight:900}],["chisel",{defaultShortPrefixId:"facr",defaultStyleId:"regular",styleIds:["regular"],futureStyleIds:[],defaultFontWeight:400}],["etch",{defaultShortPrefixId:"faes",defaultStyleId:"solid",styleIds:["solid"],futureStyleIds:[],defaultFontWeight:900}],["jelly",{defaultShortPrefixId:"fajr",defaultStyleId:"regular",styleIds:["regular"],futureStyleIds:[],defaultFontWeight:400}],["jelly-duo",{defaultShortPrefixId:"fajdr",defaultStyleId:"regular",styleIds:["regular"],futureStyleIds:[],defaultFontWeight:400}],["jelly-fill",{defaultShortPrefixId:"fajfr",defaultStyleId:"regular",styleIds:["regular"],futureStyleIds:[],defaultFontWeight:400}],["notdog",{defaultShortPrefixId:"fans",defaultStyleId:"solid",styleIds:["solid"],futureStyleIds:[],defaultFontWeight:900}],["notdog-duo",{defaultShortPrefixId:"fands",defaultStyleId:"solid",styleIds:["solid"],futureStyleIds:[],defaultFontWeight:900}],["slab",{defaultShortPrefixId:"faslr",defaultStyleId:"regular",styleIds:["regular"],futureStyleIds:[],defaultFontWeight:400}],["slab-press",{defaultShortPrefixId:"faslpr",defaultStyleId:"regular",styleIds:["regular"],futureStyleIds:[],defaultFontWeight:400}],["thumbprint",{defaultShortPrefixId:"fatl",defaultStyleId:"light",styleIds:["light"],futureStyleIds:[],defaultFontWeight:300}],["utility",{defaultShortPrefixId:"fausb",defaultStyleId:"semibold",styleIds:["semibold"],futureStyleIds:[],defaultFontWeight:600}],["utility-duo",{defaultShortPrefixId:"faudsb",defaultStyleId:"semibold",styleIds:["semibold"],futureStyleIds:[],defaultFontWeight:600}],["utility-fill",{defaultShortPrefixId:"faufsb",defaultStyleId:"semibold",styleIds:["semibold"],futureStyleIds:[],defaultFontWeight:600}],["whiteboard",{defaultShortPrefixId:"fawsb",defaultStyleId:"semibold",styleIds:["semibold"],futureStyleIds:[],defaultFontWeight:600}]]),sr={chisel:{regular:"facr"},classic:{brands:"fab",light:"fal",regular:"far",solid:"fas",thin:"fat"},duotone:{light:"fadl",regular:"fadr",solid:"fad",thin:"fadt"},etch:{solid:"faes"},jelly:{regular:"fajr"},"jelly-duo":{regular:"fajdr"},"jelly-fill":{regular:"fajfr"},notdog:{solid:"fans"},"notdog-duo":{solid:"fands"},sharp:{light:"fasl",regular:"fasr",solid:"fass",thin:"fast"},"sharp-duotone":{light:"fasdl",regular:"fasdr",solid:"fasds",thin:"fasdt"},slab:{regular:"faslr"},"slab-press":{regular:"faslpr"},thumbprint:{light:"fatl"},utility:{semibold:"fausb"},"utility-duo":{semibold:"faudsb"},"utility-fill":{semibold:"faufsb"},whiteboard:{semibold:"fawsb"}},Be=["fak","fa-kit","fakd","fa-kit-duotone"],Qt={kit:{fak:"kit","fa-kit":"kit"},"kit-duotone":{fakd:"kit-duotone","fa-kit-duotone":"kit-duotone"}},lr=["kit"],fr="kit",ur="kit-duotone",cr="Kit",dr="Kit Duotone";v(v({},fr,cr),ur,dr);var mr={kit:{"fa-kit":"fak"}},vr={"Font Awesome Kit":{400:"fak",normal:"fak"},"Font Awesome Kit Duotone":{400:"fakd",normal:"fakd"}},hr={kit:{fak:"fa-kit"}},Zt={kit:{kit:"fak"},"kit-duotone":{"kit-duotone":"fakd"}},vt,Z={GROUP:"duotone-group",SWAP_OPACITY:"swap-opacity",PRIMARY:"primary",SECONDARY:"secondary"},gr=["fa-classic","fa-duotone","fa-sharp","fa-sharp-duotone","fa-thumbprint","fa-whiteboard","fa-notdog","fa-notdog-duo","fa-chisel","fa-etch","fa-jelly","fa-jelly-fill","fa-jelly-duo","fa-slab","fa-slab-press","fa-utility","fa-utility-duo","fa-utility-fill"],pr="classic",br="duotone",yr="sharp",xr="sharp-duotone",wr="chisel",Ar="etch",Sr="jelly",kr="jelly-duo",Pr="jelly-fill",Ir="notdog",Er="notdog-duo",Fr="slab",Or="slab-press",Cr="thumbprint",Nr="utility",jr="utility-duo",Tr="utility-fill",_r="whiteboard",$r="Classic",Mr="Duotone",Dr="Sharp",Lr="Sharp Duotone",Rr="Chisel",zr="Etch",Wr="Jelly",Ur="Jelly Duo",Yr="Jelly Fill",Hr="Notdog",Gr="Notdog Duo",Xr="Slab",Br="Slab Press",Vr="Thumbprint",Jr="Utility",Kr="Utility Duo",qr="Utility Fill",Qr="Whiteboard";vt={},v(v(v(v(v(v(v(v(v(v(vt,pr,$r),br,Mr),yr,Dr),xr,Lr),wr,Rr),Ar,zr),Sr,Wr),kr,Ur),Pr,Yr),Ir,Hr),v(v(v(v(v(v(v(v(vt,Er,Gr),Fr,Xr),Or,Br),Cr,Vr),Nr,Jr),jr,Kr),Tr,qr),_r,Qr);var Zr="kit",tn="kit-duotone",en="Kit",an="Kit Duotone";v(v({},Zr,en),tn,an);var rn={classic:{"fa-brands":"fab","fa-duotone":"fad","fa-light":"fal","fa-regular":"far","fa-solid":"fas","fa-thin":"fat"},duotone:{"fa-regular":"fadr","fa-light":"fadl","fa-thin":"fadt"},sharp:{"fa-solid":"fass","fa-regular":"fasr","fa-light":"fasl","fa-thin":"fast"},"sharp-duotone":{"fa-solid":"fasds","fa-regular":"fasdr","fa-light":"fasdl","fa-thin":"fasdt"},slab:{"fa-regular":"faslr"},"slab-press":{"fa-regular":"faslpr"},whiteboard:{"fa-semibold":"fawsb"},thumbprint:{"fa-light":"fatl"},notdog:{"fa-solid":"fans"},"notdog-duo":{"fa-solid":"fands"},etch:{"fa-solid":"faes"},jelly:{"fa-regular":"fajr"},"jelly-fill":{"fa-regular":"fajfr"},"jelly-duo":{"fa-regular":"fajdr"},chisel:{"fa-regular":"facr"},utility:{"fa-semibold":"fausb"},"utility-duo":{"fa-semibold":"faudsb"},"utility-fill":{"fa-semibold":"faufsb"}},nn={classic:["fas","far","fal","fat","fad"],duotone:["fadr","fadl","fadt"],sharp:["fass","fasr","fasl","fast"],"sharp-duotone":["fasds","fasdr","fasdl","fasdt"],slab:["faslr"],"slab-press":["faslpr"],whiteboard:["fawsb"],thumbprint:["fatl"],notdog:["fans"],"notdog-duo":["fands"],etch:["faes"],jelly:["fajr"],"jelly-fill":["fajfr"],"jelly-duo":["fajdr"],chisel:["facr"],utility:["fausb"],"utility-duo":["faudsb"],"utility-fill":["faufsb"]},wt={classic:{fab:"fa-brands",fad:"fa-duotone",fal:"fa-light",far:"fa-regular",fas:"fa-solid",fat:"fa-thin"},duotone:{fadr:"fa-regular",fadl:"fa-light",fadt:"fa-thin"},sharp:{fass:"fa-solid",fasr:"fa-regular",fasl:"fa-light",fast:"fa-thin"},"sharp-duotone":{fasds:"fa-solid",fasdr:"fa-regular",fasdl:"fa-light",fasdt:"fa-thin"},slab:{faslr:"fa-regular"},"slab-press":{faslpr:"fa-regular"},whiteboard:{fawsb:"fa-semibold"},thumbprint:{fatl:"fa-light"},notdog:{fans:"fa-solid"},"notdog-duo":{fands:"fa-solid"},etch:{faes:"fa-solid"},jelly:{fajr:"fa-regular"},"jelly-fill":{fajfr:"fa-regular"},"jelly-duo":{fajdr:"fa-regular"},chisel:{facr:"fa-regular"},utility:{fausb:"fa-semibold"},"utility-duo":{faudsb:"fa-semibold"},"utility-fill":{faufsb:"fa-semibold"}},on=["fa-solid","fa-regular","fa-light","fa-thin","fa-duotone","fa-brands","fa-semibold"],Ve=["fa","fas","far","fal","fat","fad","fadr","fadl","fadt","fab","fass","fasr","fasl","fast","fasds","fasdr","fasdl","fasdt","faslr","faslpr","fawsb","fatl","fans","fands","faes","fajr","fajfr","fajdr","facr","fausb","faudsb","faufsb"].concat(gr,on),sn=["solid","regular","light","thin","duotone","brands","semibold"],Je=[1,2,3,4,5,6,7,8,9,10],ln=Je.concat([11,12,13,14,15,16,17,18,19,20]),fn=["aw","fw","pull-left","pull-right"],un=[].concat(E(Object.keys(nn)),sn,fn,["2xs","xs","sm","lg","xl","2xl","beat","border","fade","beat-fade","bounce","flip-both","flip-horizontal","flip-vertical","flip","inverse","layers","layers-bottom-left","layers-bottom-right","layers-counter","layers-text","layers-top-left","layers-top-right","li","pull-end","pull-start","pulse","rotate-180","rotate-270","rotate-90","rotate-by","shake","spin-pulse","spin-reverse","spin","stack-1x","stack-2x","stack","ul","width-auto","width-fixed",Z.GROUP,Z.SWAP_OPACITY,Z.PRIMARY,Z.SECONDARY]).concat(Je.map(function(t){return"".concat(t,"x")})).concat(ln.map(function(t){return"w-".concat(t)})),cn={"Font Awesome 5 Free":{900:"fas",400:"far"},"Font Awesome 5 Pro":{900:"fas",400:"far",normal:"far",300:"fal"},"Font Awesome 5 Brands":{400:"fab",normal:"fab"},"Font Awesome 5 Duotone":{900:"fad"}},C="___FONT_AWESOME___",At=16,Ke="fa",qe="svg-inline--fa",D="data-fa-i2svg",St="data-fa-pseudo-element",dn="data-fa-pseudo-element-pending",Dt="data-prefix",Lt="data-icon",te="fontawesome-i2svg",mn="async",vn=["HTML","HEAD","STYLE","SCRIPT"],Qe=["::before","::after",":before",":after"],Ze=(function(){try{return!0}catch{return!1}})();function K(t){return new Proxy(t,{get:function(a,r){return r in a?a[r]:a[w]}})}var ta=f({},Fe);ta[w]=f(f(f(f({},{"fa-duotone":"duotone"}),Fe[w]),Qt.kit),Qt["kit-duotone"]);var hn=K(ta),kt=f({},sr);kt[w]=f(f(f(f({},{duotone:"fad"}),kt[w]),Zt.kit),Zt["kit-duotone"]);var ee=K(kt),Pt=f({},wt);Pt[w]=f(f({},Pt[w]),hr.kit);var Rt=K(Pt),It=f({},rn);It[w]=f(f({},It[w]),mr.kit);K(It);var gn=Da,ea="fa-layers-text",pn=La,bn=f({},nr);K(bn);var yn=["class","data-prefix","data-icon","data-fa-transform","data-fa-mask"],ht=Ra,xn=[].concat(E(lr),E(un)),X=T.FontAwesomeConfig||{};function wn(t){var e=p.querySelector("script["+t+"]");if(e)return e.getAttribute(t)}function An(t){return t===""?!0:t==="false"?!1:t==="true"?!0:t}if(p&&typeof p.querySelector=="function"){var Sn=[["data-family-prefix","familyPrefix"],["data-css-prefix","cssPrefix"],["data-family-default","familyDefault"],["data-style-default","styleDefault"],["data-replacement-class","replacementClass"],["data-auto-replace-svg","autoReplaceSvg"],["data-auto-add-css","autoAddCss"],["data-search-pseudo-elements","searchPseudoElements"],["data-search-pseudo-elements-warnings","searchPseudoElementsWarnings"],["data-search-pseudo-elements-full-scan","searchPseudoElementsFullScan"],["data-observe-mutations","observeMutations"],["data-mutate-approach","mutateApproach"],["data-keep-original-source","keepOriginalSource"],["data-measure-performance","measurePerformance"],["data-show-missing-icons","showMissingIcons"]];Sn.forEach(function(t){var e=ot(t,2),a=e[0],r=e[1],n=An(wn(a));n!=null&&(X[r]=n)})}var aa={styleDefault:"solid",familyDefault:w,cssPrefix:Ke,replacementClass:qe,autoReplaceSvg:!0,autoAddCss:!0,searchPseudoElements:!1,searchPseudoElementsWarnings:!0,searchPseudoElementsFullScan:!1,observeMutations:!0,mutateApproach:"async",keepOriginalSource:!0,measurePerformance:!1,showMissingIcons:!0};X.familyPrefix&&(X.cssPrefix=X.familyPrefix);var Y=f(f({},aa),X);Y.autoReplaceSvg||(Y.observeMutations=!1);var d={};Object.keys(aa).forEach(function(t){Object.defineProperty(d,t,{enumerable:!0,set:function(a){Y[t]=a,B.forEach(function(r){return r(d)})},get:function(){return Y[t]}})});Object.defineProperty(d,"familyPrefix",{enumerable:!0,set:function(e){Y.cssPrefix=e,B.forEach(function(a){return a(d)})},get:function(){return Y.cssPrefix}});T.FontAwesomeConfig=d;var B=[];function kn(t){return B.push(t),function(){B.splice(B.indexOf(t),1)}}var z=At,F={size:16,x:0,y:0,rotate:0,flipX:!1,flipY:!1};function Pn(t){if(!(!t||!j)){var e=p.createElement("style");e.setAttribute("type","text/css"),e.innerHTML=t;for(var a=p.head.childNodes,r=null,n=a.length-1;n>-1;n--){var o=a[n],i=(o.tagName||"").toUpperCase();["STYLE","LINK"].indexOf(i)>-1&&(r=o)}return p.head.insertBefore(e,r),t}}var In="0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";function ae(){for(var t=12,e="";t-- >0;)e+=In[Math.random()*62|0];return e}function H(t){for(var e=[],a=(t||[]).length>>>0;a--;)e[a]=t[a];return e}function zt(t){return t.classList?H(t.classList):(t.getAttribute("class")||"").split(" ").filter(function(e){return e})}function ra(t){return"".concat(t).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/'/g,"&#39;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}function En(t){return Object.keys(t||{}).reduce(function(e,a){return e+"".concat(a,'="').concat(ra(t[a]),'" ')},"").trim()}function st(t){return Object.keys(t||{}).reduce(function(e,a){return e+"".concat(a,": ").concat(t[a].trim(),";")},"")}function Wt(t){return t.size!==F.size||t.x!==F.x||t.y!==F.y||t.rotate!==F.rotate||t.flipX||t.flipY}function Fn(t){var e=t.transform,a=t.containerWidth,r=t.iconWidth,n={transform:"translate(".concat(a/2," 256)")},o="translate(".concat(e.x*32,", ").concat(e.y*32,") "),i="scale(".concat(e.size/16*(e.flipX?-1:1),", ").concat(e.size/16*(e.flipY?-1:1),") "),s="rotate(".concat(e.rotate," 0 0)"),l={transform:"".concat(o," ").concat(i," ").concat(s)},u={transform:"translate(".concat(r/2*-1," -256)")};return{outer:n,inner:l,path:u}}function On(t){var e=t.transform,a=t.width,r=a===void 0?At:a,n=t.height,o=n===void 0?At:n,i="";return Ee?i+="translate(".concat(e.x/z-r/2,"em, ").concat(e.y/z-o/2,"em) "):i+="translate(calc(-50% + ".concat(e.x/z,"em), calc(-50% + ").concat(e.y/z,"em)) "),i+="scale(".concat(e.size/z*(e.flipX?-1:1),", ").concat(e.size/z*(e.flipY?-1:1),") "),i+="rotate(".concat(e.rotate,"deg) "),i}var Cn=`:root, :host {
  --fa-font-solid: normal 900 1em/1 "Font Awesome 7 Free";
  --fa-font-regular: normal 400 1em/1 "Font Awesome 7 Free";
  --fa-font-light: normal 300 1em/1 "Font Awesome 7 Pro";
  --fa-font-thin: normal 100 1em/1 "Font Awesome 7 Pro";
  --fa-font-duotone: normal 900 1em/1 "Font Awesome 7 Duotone";
  --fa-font-duotone-regular: normal 400 1em/1 "Font Awesome 7 Duotone";
  --fa-font-duotone-light: normal 300 1em/1 "Font Awesome 7 Duotone";
  --fa-font-duotone-thin: normal 100 1em/1 "Font Awesome 7 Duotone";
  --fa-font-brands: normal 400 1em/1 "Font Awesome 7 Brands";
  --fa-font-sharp-solid: normal 900 1em/1 "Font Awesome 7 Sharp";
  --fa-font-sharp-regular: normal 400 1em/1 "Font Awesome 7 Sharp";
  --fa-font-sharp-light: normal 300 1em/1 "Font Awesome 7 Sharp";
  --fa-font-sharp-thin: normal 100 1em/1 "Font Awesome 7 Sharp";
  --fa-font-sharp-duotone-solid: normal 900 1em/1 "Font Awesome 7 Sharp Duotone";
  --fa-font-sharp-duotone-regular: normal 400 1em/1 "Font Awesome 7 Sharp Duotone";
  --fa-font-sharp-duotone-light: normal 300 1em/1 "Font Awesome 7 Sharp Duotone";
  --fa-font-sharp-duotone-thin: normal 100 1em/1 "Font Awesome 7 Sharp Duotone";
  --fa-font-slab-regular: normal 400 1em/1 "Font Awesome 7 Slab";
  --fa-font-slab-press-regular: normal 400 1em/1 "Font Awesome 7 Slab Press";
  --fa-font-whiteboard-semibold: normal 600 1em/1 "Font Awesome 7 Whiteboard";
  --fa-font-thumbprint-light: normal 300 1em/1 "Font Awesome 7 Thumbprint";
  --fa-font-notdog-solid: normal 900 1em/1 "Font Awesome 7 Notdog";
  --fa-font-notdog-duo-solid: normal 900 1em/1 "Font Awesome 7 Notdog Duo";
  --fa-font-etch-solid: normal 900 1em/1 "Font Awesome 7 Etch";
  --fa-font-jelly-regular: normal 400 1em/1 "Font Awesome 7 Jelly";
  --fa-font-jelly-fill-regular: normal 400 1em/1 "Font Awesome 7 Jelly Fill";
  --fa-font-jelly-duo-regular: normal 400 1em/1 "Font Awesome 7 Jelly Duo";
  --fa-font-chisel-regular: normal 400 1em/1 "Font Awesome 7 Chisel";
  --fa-font-utility-semibold: normal 600 1em/1 "Font Awesome 7 Utility";
  --fa-font-utility-duo-semibold: normal 600 1em/1 "Font Awesome 7 Utility Duo";
  --fa-font-utility-fill-semibold: normal 600 1em/1 "Font Awesome 7 Utility Fill";
}

.svg-inline--fa {
  box-sizing: content-box;
  display: var(--fa-display, inline-block);
  height: 1em;
  overflow: visible;
  vertical-align: -0.125em;
  width: var(--fa-width, 1.25em);
}
.svg-inline--fa.fa-2xs {
  vertical-align: 0.1em;
}
.svg-inline--fa.fa-xs {
  vertical-align: 0em;
}
.svg-inline--fa.fa-sm {
  vertical-align: -0.0714285714em;
}
.svg-inline--fa.fa-lg {
  vertical-align: -0.2em;
}
.svg-inline--fa.fa-xl {
  vertical-align: -0.25em;
}
.svg-inline--fa.fa-2xl {
  vertical-align: -0.3125em;
}
.svg-inline--fa.fa-pull-left,
.svg-inline--fa .fa-pull-start {
  float: inline-start;
  margin-inline-end: var(--fa-pull-margin, 0.3em);
}
.svg-inline--fa.fa-pull-right,
.svg-inline--fa .fa-pull-end {
  float: inline-end;
  margin-inline-start: var(--fa-pull-margin, 0.3em);
}
.svg-inline--fa.fa-li {
  width: var(--fa-li-width, 2em);
  inset-inline-start: calc(-1 * var(--fa-li-width, 2em));
  inset-block-start: 0.25em; /* syncing vertical alignment with Web Font rendering */
}

.fa-layers-counter, .fa-layers-text {
  display: inline-block;
  position: absolute;
  text-align: center;
}

.fa-layers {
  display: inline-block;
  height: 1em;
  position: relative;
  text-align: center;
  vertical-align: -0.125em;
  width: var(--fa-width, 1.25em);
}
.fa-layers .svg-inline--fa {
  inset: 0;
  margin: auto;
  position: absolute;
  transform-origin: center center;
}

.fa-layers-text {
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  transform-origin: center center;
}

.fa-layers-counter {
  background-color: var(--fa-counter-background-color, #ff253a);
  border-radius: var(--fa-counter-border-radius, 1em);
  box-sizing: border-box;
  color: var(--fa-inverse, #fff);
  line-height: var(--fa-counter-line-height, 1);
  max-width: var(--fa-counter-max-width, 5em);
  min-width: var(--fa-counter-min-width, 1.5em);
  overflow: hidden;
  padding: var(--fa-counter-padding, 0.25em 0.5em);
  right: var(--fa-right, 0);
  text-overflow: ellipsis;
  top: var(--fa-top, 0);
  transform: scale(var(--fa-counter-scale, 0.25));
  transform-origin: top right;
}

.fa-layers-bottom-right {
  bottom: var(--fa-bottom, 0);
  right: var(--fa-right, 0);
  top: auto;
  transform: scale(var(--fa-layers-scale, 0.25));
  transform-origin: bottom right;
}

.fa-layers-bottom-left {
  bottom: var(--fa-bottom, 0);
  left: var(--fa-left, 0);
  right: auto;
  top: auto;
  transform: scale(var(--fa-layers-scale, 0.25));
  transform-origin: bottom left;
}

.fa-layers-top-right {
  top: var(--fa-top, 0);
  right: var(--fa-right, 0);
  transform: scale(var(--fa-layers-scale, 0.25));
  transform-origin: top right;
}

.fa-layers-top-left {
  left: var(--fa-left, 0);
  right: auto;
  top: var(--fa-top, 0);
  transform: scale(var(--fa-layers-scale, 0.25));
  transform-origin: top left;
}

.fa-1x {
  font-size: 1em;
}

.fa-2x {
  font-size: 2em;
}

.fa-3x {
  font-size: 3em;
}

.fa-4x {
  font-size: 4em;
}

.fa-5x {
  font-size: 5em;
}

.fa-6x {
  font-size: 6em;
}

.fa-7x {
  font-size: 7em;
}

.fa-8x {
  font-size: 8em;
}

.fa-9x {
  font-size: 9em;
}

.fa-10x {
  font-size: 10em;
}

.fa-2xs {
  font-size: calc(10 / 16 * 1em); /* converts a 10px size into an em-based value that's relative to the scale's 16px base */
  line-height: calc(1 / 10 * 1em); /* sets the line-height of the icon back to that of it's parent */
  vertical-align: calc((6 / 10 - 0.375) * 1em); /* vertically centers the icon taking into account the surrounding text's descender */
}

.fa-xs {
  font-size: calc(12 / 16 * 1em); /* converts a 12px size into an em-based value that's relative to the scale's 16px base */
  line-height: calc(1 / 12 * 1em); /* sets the line-height of the icon back to that of it's parent */
  vertical-align: calc((6 / 12 - 0.375) * 1em); /* vertically centers the icon taking into account the surrounding text's descender */
}

.fa-sm {
  font-size: calc(14 / 16 * 1em); /* converts a 14px size into an em-based value that's relative to the scale's 16px base */
  line-height: calc(1 / 14 * 1em); /* sets the line-height of the icon back to that of it's parent */
  vertical-align: calc((6 / 14 - 0.375) * 1em); /* vertically centers the icon taking into account the surrounding text's descender */
}

.fa-lg {
  font-size: calc(20 / 16 * 1em); /* converts a 20px size into an em-based value that's relative to the scale's 16px base */
  line-height: calc(1 / 20 * 1em); /* sets the line-height of the icon back to that of it's parent */
  vertical-align: calc((6 / 20 - 0.375) * 1em); /* vertically centers the icon taking into account the surrounding text's descender */
}

.fa-xl {
  font-size: calc(24 / 16 * 1em); /* converts a 24px size into an em-based value that's relative to the scale's 16px base */
  line-height: calc(1 / 24 * 1em); /* sets the line-height of the icon back to that of it's parent */
  vertical-align: calc((6 / 24 - 0.375) * 1em); /* vertically centers the icon taking into account the surrounding text's descender */
}

.fa-2xl {
  font-size: calc(32 / 16 * 1em); /* converts a 32px size into an em-based value that's relative to the scale's 16px base */
  line-height: calc(1 / 32 * 1em); /* sets the line-height of the icon back to that of it's parent */
  vertical-align: calc((6 / 32 - 0.375) * 1em); /* vertically centers the icon taking into account the surrounding text's descender */
}

.fa-width-auto {
  --fa-width: auto;
}

.fa-fw,
.fa-width-fixed {
  --fa-width: 1.25em;
}

.fa-ul {
  list-style-type: none;
  margin-inline-start: var(--fa-li-margin, 2.5em);
  padding-inline-start: 0;
}
.fa-ul > li {
  position: relative;
}

.fa-li {
  inset-inline-start: calc(-1 * var(--fa-li-width, 2em));
  position: absolute;
  text-align: center;
  width: var(--fa-li-width, 2em);
  line-height: inherit;
}

/* Heads Up: Bordered Icons will not be supported in the future!
  - This feature will be deprecated in the next major release of Font Awesome (v8)!
  - You may continue to use it in this version *v7), but it will not be supported in Font Awesome v8.
*/
/* Notes:
* --@{v.$css-prefix}-border-width = 1/16 by default (to render as ~1px based on a 16px default font-size)
* --@{v.$css-prefix}-border-padding =
  ** 3/16 for vertical padding (to give ~2px of vertical whitespace around an icon considering it's vertical alignment)
  ** 4/16 for horizontal padding (to give ~4px of horizontal whitespace around an icon)
*/
.fa-border {
  border-color: var(--fa-border-color, #eee);
  border-radius: var(--fa-border-radius, 0.1em);
  border-style: var(--fa-border-style, solid);
  border-width: var(--fa-border-width, 0.0625em);
  box-sizing: var(--fa-border-box-sizing, content-box);
  padding: var(--fa-border-padding, 0.1875em 0.25em);
}

.fa-pull-left,
.fa-pull-start {
  float: inline-start;
  margin-inline-end: var(--fa-pull-margin, 0.3em);
}

.fa-pull-right,
.fa-pull-end {
  float: inline-end;
  margin-inline-start: var(--fa-pull-margin, 0.3em);
}

.fa-beat {
  animation-name: fa-beat;
  animation-delay: var(--fa-animation-delay, 0s);
  animation-direction: var(--fa-animation-direction, normal);
  animation-duration: var(--fa-animation-duration, 1s);
  animation-iteration-count: var(--fa-animation-iteration-count, infinite);
  animation-timing-function: var(--fa-animation-timing, ease-in-out);
}

.fa-bounce {
  animation-name: fa-bounce;
  animation-delay: var(--fa-animation-delay, 0s);
  animation-direction: var(--fa-animation-direction, normal);
  animation-duration: var(--fa-animation-duration, 1s);
  animation-iteration-count: var(--fa-animation-iteration-count, infinite);
  animation-timing-function: var(--fa-animation-timing, cubic-bezier(0.28, 0.84, 0.42, 1));
}

.fa-fade {
  animation-name: fa-fade;
  animation-delay: var(--fa-animation-delay, 0s);
  animation-direction: var(--fa-animation-direction, normal);
  animation-duration: var(--fa-animation-duration, 1s);
  animation-iteration-count: var(--fa-animation-iteration-count, infinite);
  animation-timing-function: var(--fa-animation-timing, cubic-bezier(0.4, 0, 0.6, 1));
}

.fa-beat-fade {
  animation-name: fa-beat-fade;
  animation-delay: var(--fa-animation-delay, 0s);
  animation-direction: var(--fa-animation-direction, normal);
  animation-duration: var(--fa-animation-duration, 1s);
  animation-iteration-count: var(--fa-animation-iteration-count, infinite);
  animation-timing-function: var(--fa-animation-timing, cubic-bezier(0.4, 0, 0.6, 1));
}

.fa-flip {
  animation-name: fa-flip;
  animation-delay: var(--fa-animation-delay, 0s);
  animation-direction: var(--fa-animation-direction, normal);
  animation-duration: var(--fa-animation-duration, 1s);
  animation-iteration-count: var(--fa-animation-iteration-count, infinite);
  animation-timing-function: var(--fa-animation-timing, ease-in-out);
}

.fa-shake {
  animation-name: fa-shake;
  animation-delay: var(--fa-animation-delay, 0s);
  animation-direction: var(--fa-animation-direction, normal);
  animation-duration: var(--fa-animation-duration, 1s);
  animation-iteration-count: var(--fa-animation-iteration-count, infinite);
  animation-timing-function: var(--fa-animation-timing, linear);
}

.fa-spin {
  animation-name: fa-spin;
  animation-delay: var(--fa-animation-delay, 0s);
  animation-direction: var(--fa-animation-direction, normal);
  animation-duration: var(--fa-animation-duration, 2s);
  animation-iteration-count: var(--fa-animation-iteration-count, infinite);
  animation-timing-function: var(--fa-animation-timing, linear);
}

.fa-spin-reverse {
  --fa-animation-direction: reverse;
}

.fa-pulse,
.fa-spin-pulse {
  animation-name: fa-spin;
  animation-direction: var(--fa-animation-direction, normal);
  animation-duration: var(--fa-animation-duration, 1s);
  animation-iteration-count: var(--fa-animation-iteration-count, infinite);
  animation-timing-function: var(--fa-animation-timing, steps(8));
}

@media (prefers-reduced-motion: reduce) {
  .fa-beat,
  .fa-bounce,
  .fa-fade,
  .fa-beat-fade,
  .fa-flip,
  .fa-pulse,
  .fa-shake,
  .fa-spin,
  .fa-spin-pulse {
    animation: none !important;
    transition: none !important;
  }
}
@keyframes fa-beat {
  0%, 90% {
    transform: scale(1);
  }
  45% {
    transform: scale(var(--fa-beat-scale, 1.25));
  }
}
@keyframes fa-bounce {
  0% {
    transform: scale(1, 1) translateY(0);
  }
  10% {
    transform: scale(var(--fa-bounce-start-scale-x, 1.1), var(--fa-bounce-start-scale-y, 0.9)) translateY(0);
  }
  30% {
    transform: scale(var(--fa-bounce-jump-scale-x, 0.9), var(--fa-bounce-jump-scale-y, 1.1)) translateY(var(--fa-bounce-height, -0.5em));
  }
  50% {
    transform: scale(var(--fa-bounce-land-scale-x, 1.05), var(--fa-bounce-land-scale-y, 0.95)) translateY(0);
  }
  57% {
    transform: scale(1, 1) translateY(var(--fa-bounce-rebound, -0.125em));
  }
  64% {
    transform: scale(1, 1) translateY(0);
  }
  100% {
    transform: scale(1, 1) translateY(0);
  }
}
@keyframes fa-fade {
  50% {
    opacity: var(--fa-fade-opacity, 0.4);
  }
}
@keyframes fa-beat-fade {
  0%, 100% {
    opacity: var(--fa-beat-fade-opacity, 0.4);
    transform: scale(1);
  }
  50% {
    opacity: 1;
    transform: scale(var(--fa-beat-fade-scale, 1.125));
  }
}
@keyframes fa-flip {
  50% {
    transform: rotate3d(var(--fa-flip-x, 0), var(--fa-flip-y, 1), var(--fa-flip-z, 0), var(--fa-flip-angle, -180deg));
  }
}
@keyframes fa-shake {
  0% {
    transform: rotate(-15deg);
  }
  4% {
    transform: rotate(15deg);
  }
  8%, 24% {
    transform: rotate(-18deg);
  }
  12%, 28% {
    transform: rotate(18deg);
  }
  16% {
    transform: rotate(-22deg);
  }
  20% {
    transform: rotate(22deg);
  }
  32% {
    transform: rotate(-12deg);
  }
  36% {
    transform: rotate(12deg);
  }
  40%, 100% {
    transform: rotate(0deg);
  }
}
@keyframes fa-spin {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}
.fa-rotate-90 {
  transform: rotate(90deg);
}

.fa-rotate-180 {
  transform: rotate(180deg);
}

.fa-rotate-270 {
  transform: rotate(270deg);
}

.fa-flip-horizontal {
  transform: scale(-1, 1);
}

.fa-flip-vertical {
  transform: scale(1, -1);
}

.fa-flip-both,
.fa-flip-horizontal.fa-flip-vertical {
  transform: scale(-1, -1);
}

.fa-rotate-by {
  transform: rotate(var(--fa-rotate-angle, 0));
}

.svg-inline--fa .fa-primary {
  fill: var(--fa-primary-color, currentColor);
  opacity: var(--fa-primary-opacity, 1);
}

.svg-inline--fa .fa-secondary {
  fill: var(--fa-secondary-color, currentColor);
  opacity: var(--fa-secondary-opacity, 0.4);
}

.svg-inline--fa.fa-swap-opacity .fa-primary {
  opacity: var(--fa-secondary-opacity, 0.4);
}

.svg-inline--fa.fa-swap-opacity .fa-secondary {
  opacity: var(--fa-primary-opacity, 1);
}

.svg-inline--fa mask .fa-primary,
.svg-inline--fa mask .fa-secondary {
  fill: black;
}

.svg-inline--fa.fa-inverse {
  fill: var(--fa-inverse, #fff);
}

.fa-stack {
  display: inline-block;
  height: 2em;
  line-height: 2em;
  position: relative;
  vertical-align: middle;
  width: 2.5em;
}

.fa-inverse {
  color: var(--fa-inverse, #fff);
}

.svg-inline--fa.fa-stack-1x {
  --fa-width: 1.25em;
  height: 1em;
  width: var(--fa-width);
}
.svg-inline--fa.fa-stack-2x {
  --fa-width: 2.5em;
  height: 2em;
  width: var(--fa-width);
}

.fa-stack-1x,
.fa-stack-2x {
  inset: 0;
  margin: auto;
  position: absolute;
  z-index: var(--fa-stack-z-index, auto);
}`;function na(){var t=Ke,e=qe,a=d.cssPrefix,r=d.replacementClass,n=Cn;if(a!==t||r!==e){var o=new RegExp("\\.".concat(t,"\\-"),"g"),i=new RegExp("\\--".concat(t,"\\-"),"g"),s=new RegExp("\\.".concat(e),"g");n=n.replace(o,".".concat(a,"-")).replace(i,"--".concat(a,"-")).replace(s,".".concat(r))}return n}var re=!1;function gt(){d.autoAddCss&&!re&&(Pn(na()),re=!0)}var Nn={mixout:function(){return{dom:{css:na,insertCss:gt}}},hooks:function(){return{beforeDOMElementCreation:function(){gt()},beforeI2svg:function(){gt()}}}},N=T||{};N[C]||(N[C]={});N[C].styles||(N[C].styles={});N[C].hooks||(N[C].hooks={});N[C].shims||(N[C].shims=[]);var I=N[C],ia=[],oa=function(){p.removeEventListener("DOMContentLoaded",oa),nt=1,ia.map(function(e){return e()})},nt=!1;j&&(nt=(p.documentElement.doScroll?/^loaded|^c/:/^loaded|^i|^c/).test(p.readyState),nt||p.addEventListener("DOMContentLoaded",oa));function jn(t){j&&(nt?setTimeout(t,0):ia.push(t))}function q(t){var e=t.tag,a=t.attributes,r=a===void 0?{}:a,n=t.children,o=n===void 0?[]:n;return typeof t=="string"?ra(t):"<".concat(e," ").concat(En(r),">").concat(o.map(q).join(""),"</").concat(e,">")}function ne(t,e,a){if(t&&t[e]&&t[e][a])return{prefix:e,iconName:a,icon:t[e][a]}}var pt=function(e,a,r,n){var o=Object.keys(e),i=o.length,s=a,l,u,m;for(r===void 0?(l=1,m=e[o[0]]):(l=0,m=r);l<i;l++)u=o[l],m=s(m,e[u],u,e);return m};function sa(t){return E(t).length!==1?null:t.codePointAt(0).toString(16)}function ie(t){return Object.keys(t).reduce(function(e,a){var r=t[a],n=!!r.icon;return n?e[r.iconName]=r.icon:e[a]=r,e},{})}function Et(t,e){var a=arguments.length>2&&arguments[2]!==void 0?arguments[2]:{},r=a.skipHooks,n=r===void 0?!1:r,o=ie(e);typeof I.hooks.addPack=="function"&&!n?I.hooks.addPack(t,ie(e)):I.styles[t]=f(f({},I.styles[t]||{}),o),t==="fas"&&Et("fa",e)}var V=I.styles,Tn=I.shims,la=Object.keys(Rt),_n=la.reduce(function(t,e){return t[e]=Object.keys(Rt[e]),t},{}),Ut=null,fa={},ua={},ca={},da={},ma={};function $n(t){return~xn.indexOf(t)}function Mn(t,e){var a=e.split("-"),r=a[0],n=a.slice(1).join("-");return r===t&&n!==""&&!$n(n)?n:null}var va=function(){var e=function(o){return pt(V,function(i,s,l){return i[l]=pt(s,o,{}),i},{})};fa=e(function(n,o,i){if(o[3]&&(n[o[3]]=i),o[2]){var s=o[2].filter(function(l){return typeof l=="number"});s.forEach(function(l){n[l.toString(16)]=i})}return n}),ua=e(function(n,o,i){if(n[i]=i,o[2]){var s=o[2].filter(function(l){return typeof l=="string"});s.forEach(function(l){n[l]=i})}return n}),ma=e(function(n,o,i){var s=o[2];return n[i]=i,s.forEach(function(l){n[l]=i}),n});var a="far"in V||d.autoFetchSvg,r=pt(Tn,function(n,o){var i=o[0],s=o[1],l=o[2];return s==="far"&&!a&&(s="fas"),typeof i=="string"&&(n.names[i]={prefix:s,iconName:l}),typeof i=="number"&&(n.unicodes[i.toString(16)]={prefix:s,iconName:l}),n},{names:{},unicodes:{}});ca=r.names,da=r.unicodes,Ut=lt(d.styleDefault,{family:d.familyDefault})};kn(function(t){Ut=lt(t.styleDefault,{family:d.familyDefault})});va();function Yt(t,e){return(fa[t]||{})[e]}function Dn(t,e){return(ua[t]||{})[e]}function M(t,e){return(ma[t]||{})[e]}function ha(t){return ca[t]||{prefix:null,iconName:null}}function Ln(t){var e=da[t],a=Yt("fas",t);return e||(a?{prefix:"fas",iconName:a}:null)||{prefix:null,iconName:null}}function _(){return Ut}var ga=function(){return{prefix:null,iconName:null,rest:[]}};function Rn(t){var e=w,a=la.reduce(function(r,n){return r[n]="".concat(d.cssPrefix,"-").concat(n),r},{});return Xe.forEach(function(r){(t.includes(a[r])||t.some(function(n){return _n[r].includes(n)}))&&(e=r)}),e}function lt(t){var e=arguments.length>1&&arguments[1]!==void 0?arguments[1]:{},a=e.family,r=a===void 0?w:a,n=hn[r][t];if(r===J&&!t)return"fad";var o=ee[r][t]||ee[r][n],i=t in I.styles?t:null,s=o||i||null;return s}function zn(t){var e=[],a=null;return t.forEach(function(r){var n=Mn(d.cssPrefix,r);n?a=n:r&&e.push(r)}),{iconName:a,rest:e}}function oe(t){return t.sort().filter(function(e,a,r){return r.indexOf(e)===a})}var se=Ve.concat(Be);function ft(t){var e=arguments.length>1&&arguments[1]!==void 0?arguments[1]:{},a=e.skipLookups,r=a===void 0?!1:a,n=null,o=oe(t.filter(function(h){return se.includes(h)})),i=oe(t.filter(function(h){return!se.includes(h)})),s=o.filter(function(h){return n=h,!Oe.includes(h)}),l=ot(s,1),u=l[0],m=u===void 0?null:u,c=Rn(o),g=f(f({},zn(i)),{},{prefix:lt(m,{family:c})});return f(f(f({},g),Hn({values:t,family:c,styles:V,config:d,canonical:g,givenPrefix:n})),Wn(r,n,g))}function Wn(t,e,a){var r=a.prefix,n=a.iconName;if(t||!r||!n)return{prefix:r,iconName:n};var o=e==="fa"?ha(n):{},i=M(r,n);return n=o.iconName||i||n,r=o.prefix||r,r==="far"&&!V.far&&V.fas&&!d.autoFetchSvg&&(r="fas"),{prefix:r,iconName:n}}var Un=Xe.filter(function(t){return t!==w||t!==J}),Yn=Object.keys(wt).filter(function(t){return t!==w}).map(function(t){return Object.keys(wt[t])}).flat();function Hn(t){var e=t.values,a=t.family,r=t.canonical,n=t.givenPrefix,o=n===void 0?"":n,i=t.styles,s=i===void 0?{}:i,l=t.config,u=l===void 0?{}:l,m=a===J,c=e.includes("fa-duotone")||e.includes("fad"),g=u.familyDefault==="duotone",h=r.prefix==="fad"||r.prefix==="fa-duotone";if(!m&&(c||g||h)&&(r.prefix="fad"),(e.includes("fa-brands")||e.includes("fab"))&&(r.prefix="fab"),!r.prefix&&Un.includes(a)){var y=Object.keys(s).find(function(A){return Yn.includes(A)});if(y||u.autoFetchSvg){var b=or.get(a).defaultShortPrefixId;r.prefix=b,r.iconName=M(r.prefix,r.iconName)||r.iconName}}return(r.prefix==="fa"||o==="fa")&&(r.prefix=_()||"fas"),r}var Gn=(function(){function t(){Fa(this,t),this.definitions={}}return Ca(t,[{key:"add",value:function(){for(var a=this,r=arguments.length,n=new Array(r),o=0;o<r;o++)n[o]=arguments[o];var i=n.reduce(this._pullDefinitions,{});Object.keys(i).forEach(function(s){a.definitions[s]=f(f({},a.definitions[s]||{}),i[s]),Et(s,i[s]);var l=Rt[w][s];l&&Et(l,i[s]),va()})}},{key:"reset",value:function(){this.definitions={}}},{key:"_pullDefinitions",value:function(a,r){var n=r.prefix&&r.iconName&&r.icon?{0:r}:r;return Object.keys(n).map(function(o){var i=n[o],s=i.prefix,l=i.iconName,u=i.icon,m=u[2];a[s]||(a[s]={}),m.length>0&&m.forEach(function(c){typeof c=="string"&&(a[s][c]=u)}),a[s][l]=u}),a}}])})(),le=[],W={},U={},Xn=Object.keys(U);function Bn(t,e){var a=e.mixoutsTo;return le=t,W={},Object.keys(U).forEach(function(r){Xn.indexOf(r)===-1&&delete U[r]}),le.forEach(function(r){var n=r.mixout?r.mixout():{};if(Object.keys(n).forEach(function(i){typeof n[i]=="function"&&(a[i]=n[i]),rt(n[i])==="object"&&Object.keys(n[i]).forEach(function(s){a[i]||(a[i]={}),a[i][s]=n[i][s]})}),r.hooks){var o=r.hooks();Object.keys(o).forEach(function(i){W[i]||(W[i]=[]),W[i].push(o[i])})}r.provides&&r.provides(U)}),a}function Ft(t,e){for(var a=arguments.length,r=new Array(a>2?a-2:0),n=2;n<a;n++)r[n-2]=arguments[n];var o=W[t]||[];return o.forEach(function(i){e=i.apply(null,[e].concat(r))}),e}function L(t){for(var e=arguments.length,a=new Array(e>1?e-1:0),r=1;r<e;r++)a[r-1]=arguments[r];var n=W[t]||[];n.forEach(function(o){o.apply(null,a)})}function $(){var t=arguments[0],e=Array.prototype.slice.call(arguments,1);return U[t]?U[t].apply(null,e):void 0}function Ot(t){t.prefix==="fa"&&(t.prefix="fas");var e=t.iconName,a=t.prefix||_();if(e)return e=M(a,e)||e,ne(pa.definitions,a,e)||ne(I.styles,a,e)}var pa=new Gn,Vn=function(){d.autoReplaceSvg=!1,d.observeMutations=!1,L("noAuto")},Jn={i2svg:function(){var e=arguments.length>0&&arguments[0]!==void 0?arguments[0]:{};return j?(L("beforeI2svg",e),$("pseudoElements2svg",e),$("i2svg",e)):Promise.reject(new Error("Operation requires a DOM of some kind."))},watch:function(){var e=arguments.length>0&&arguments[0]!==void 0?arguments[0]:{},a=e.autoReplaceSvgRoot;d.autoReplaceSvg===!1&&(d.autoReplaceSvg=!0),d.observeMutations=!0,jn(function(){qn({autoReplaceSvgRoot:a}),L("watch",e)})}},Kn={icon:function(e){if(e===null)return null;if(rt(e)==="object"&&e.prefix&&e.iconName)return{prefix:e.prefix,iconName:M(e.prefix,e.iconName)||e.iconName};if(Array.isArray(e)&&e.length===2){var a=e[1].indexOf("fa-")===0?e[1].slice(3):e[1],r=lt(e[0]);return{prefix:r,iconName:M(r,a)||a}}if(typeof e=="string"&&(e.indexOf("".concat(d.cssPrefix,"-"))>-1||e.match(gn))){var n=ft(e.split(" "),{skipLookups:!0});return{prefix:n.prefix||_(),iconName:M(n.prefix,n.iconName)||n.iconName}}if(typeof e=="string"){var o=_();return{prefix:o,iconName:M(o,e)||e}}}},k={noAuto:Vn,config:d,dom:Jn,parse:Kn,library:pa,findIconDefinition:Ot,toHtml:q},qn=function(){var e=arguments.length>0&&arguments[0]!==void 0?arguments[0]:{},a=e.autoReplaceSvgRoot,r=a===void 0?p:a;(Object.keys(I.styles).length>0||d.autoFetchSvg)&&j&&d.autoReplaceSvg&&k.dom.i2svg({node:r})};function ut(t,e){return Object.defineProperty(t,"abstract",{get:e}),Object.defineProperty(t,"html",{get:function(){return t.abstract.map(function(r){return q(r)})}}),Object.defineProperty(t,"node",{get:function(){if(j){var r=p.createElement("div");return r.innerHTML=t.html,r.children}}}),t}function Qn(t){var e=t.children,a=t.main,r=t.mask,n=t.attributes,o=t.styles,i=t.transform;if(Wt(i)&&a.found&&!r.found){var s=a.width,l=a.height,u={x:s/l/2,y:.5};n.style=st(f(f({},o),{},{"transform-origin":"".concat(u.x+i.x/16,"em ").concat(u.y+i.y/16,"em")}))}return[{tag:"svg",attributes:n,children:e}]}function Zn(t){var e=t.prefix,a=t.iconName,r=t.children,n=t.attributes,o=t.symbol,i=o===!0?"".concat(e,"-").concat(d.cssPrefix,"-").concat(a):o;return[{tag:"svg",attributes:{style:"display: none;"},children:[{tag:"symbol",attributes:f(f({},n),{},{id:i}),children:r}]}]}function ti(t){var e=["aria-label","aria-labelledby","title","role"];return e.some(function(a){return a in t})}function Ht(t){var e=t.icons,a=e.main,r=e.mask,n=t.prefix,o=t.iconName,i=t.transform,s=t.symbol,l=t.maskId,u=t.extra,m=t.watchable,c=m===void 0?!1:m,g=r.found?r:a,h=g.width,y=g.height,b=[d.replacementClass,o?"".concat(d.cssPrefix,"-").concat(o):""].filter(function(O){return u.classes.indexOf(O)===-1}).filter(function(O){return O!==""||!!O}).concat(u.classes).join(" "),A={children:[],attributes:f(f({},u.attributes),{},{"data-prefix":n,"data-icon":o,class:b,role:u.attributes.role||"img",viewBox:"0 0 ".concat(h," ").concat(y)})};!ti(u.attributes)&&!u.attributes["aria-hidden"]&&(A.attributes["aria-hidden"]="true"),c&&(A.attributes[D]="");var x=f(f({},A),{},{prefix:n,iconName:o,main:a,mask:r,maskId:l,transform:i,symbol:s,styles:f({},u.styles)}),S=r.found&&a.found?$("generateAbstractMask",x)||{children:[],attributes:{}}:$("generateAbstractIcon",x)||{children:[],attributes:{}},P=S.children,R=S.attributes;return x.children=P,x.attributes=R,s?Zn(x):Qn(x)}function fe(t){var e=t.content,a=t.width,r=t.height,n=t.transform,o=t.extra,i=t.watchable,s=i===void 0?!1:i,l=f(f({},o.attributes),{},{class:o.classes.join(" ")});s&&(l[D]="");var u=f({},o.styles);Wt(n)&&(u.transform=On({transform:n,width:a,height:r}),u["-webkit-transform"]=u.transform);var m=st(u);m.length>0&&(l.style=m);var c=[];return c.push({tag:"span",attributes:l,children:[e]}),c}function ei(t){var e=t.content,a=t.extra,r=f(f({},a.attributes),{},{class:a.classes.join(" ")}),n=st(a.styles);n.length>0&&(r.style=n);var o=[];return o.push({tag:"span",attributes:r,children:[e]}),o}var bt=I.styles;function Ct(t){var e=t[0],a=t[1],r=t.slice(4),n=ot(r,1),o=n[0],i=null;return Array.isArray(o)?i={tag:"g",attributes:{class:"".concat(d.cssPrefix,"-").concat(ht.GROUP)},children:[{tag:"path",attributes:{class:"".concat(d.cssPrefix,"-").concat(ht.SECONDARY),fill:"currentColor",d:o[0]}},{tag:"path",attributes:{class:"".concat(d.cssPrefix,"-").concat(ht.PRIMARY),fill:"currentColor",d:o[1]}}]}:i={tag:"path",attributes:{fill:"currentColor",d:o}},{found:!0,width:e,height:a,icon:i}}var ai={found:!1,width:512,height:512};function ri(t,e){!Ze&&!d.showMissingIcons&&t&&console.error('Icon with name "'.concat(t,'" and prefix "').concat(e,'" is missing.'))}function Nt(t,e){var a=e;return e==="fa"&&d.styleDefault!==null&&(e=_()),new Promise(function(r,n){if(a==="fa"){var o=ha(t)||{};t=o.iconName||t,e=o.prefix||e}if(t&&e&&bt[e]&&bt[e][t]){var i=bt[e][t];return r(Ct(i))}ri(t,e),r(f(f({},ai),{},{icon:d.showMissingIcons&&t?$("missingIconAbstract")||{}:{}}))})}var ue=function(){},jt=d.measurePerformance&&Q&&Q.mark&&Q.measure?Q:{mark:ue,measure:ue},G='FA "7.1.0"',ni=function(e){return jt.mark("".concat(G," ").concat(e," begins")),function(){return ba(e)}},ba=function(e){jt.mark("".concat(G," ").concat(e," ends")),jt.measure("".concat(G," ").concat(e),"".concat(G," ").concat(e," begins"),"".concat(G," ").concat(e," ends"))},Gt={begin:ni,end:ba},et=function(){};function ce(t){var e=t.getAttribute?t.getAttribute(D):null;return typeof e=="string"}function ii(t){var e=t.getAttribute?t.getAttribute(Dt):null,a=t.getAttribute?t.getAttribute(Lt):null;return e&&a}function oi(t){return t&&t.classList&&t.classList.contains&&t.classList.contains(d.replacementClass)}function si(){if(d.autoReplaceSvg===!0)return at.replace;var t=at[d.autoReplaceSvg];return t||at.replace}function li(t){return p.createElementNS("http://www.w3.org/2000/svg",t)}function fi(t){return p.createElement(t)}function ya(t){var e=arguments.length>1&&arguments[1]!==void 0?arguments[1]:{},a=e.ceFn,r=a===void 0?t.tag==="svg"?li:fi:a;if(typeof t=="string")return p.createTextNode(t);var n=r(t.tag);Object.keys(t.attributes||[]).forEach(function(i){n.setAttribute(i,t.attributes[i])});var o=t.children||[];return o.forEach(function(i){n.appendChild(ya(i,{ceFn:r}))}),n}function ui(t){var e=" ".concat(t.outerHTML," ");return e="".concat(e,"Font Awesome fontawesome.com "),e}var at={replace:function(e){var a=e[0];if(a.parentNode)if(e[1].forEach(function(n){a.parentNode.insertBefore(ya(n),a)}),a.getAttribute(D)===null&&d.keepOriginalSource){var r=p.createComment(ui(a));a.parentNode.replaceChild(r,a)}else a.remove()},nest:function(e){var a=e[0],r=e[1];if(~zt(a).indexOf(d.replacementClass))return at.replace(e);var n=new RegExp("".concat(d.cssPrefix,"-.*"));if(delete r[0].attributes.id,r[0].attributes.class){var o=r[0].attributes.class.split(" ").reduce(function(s,l){return l===d.replacementClass||l.match(n)?s.toSvg.push(l):s.toNode.push(l),s},{toNode:[],toSvg:[]});r[0].attributes.class=o.toSvg.join(" "),o.toNode.length===0?a.removeAttribute("class"):a.setAttribute("class",o.toNode.join(" "))}var i=r.map(function(s){return q(s)}).join(`
`);a.setAttribute(D,""),a.innerHTML=i}};function de(t){t()}function xa(t,e){var a=typeof e=="function"?e:et;if(t.length===0)a();else{var r=de;d.mutateApproach===mn&&(r=T.requestAnimationFrame||de),r(function(){var n=si(),o=Gt.begin("mutate");t.map(n),o(),a()})}}var Xt=!1;function wa(){Xt=!0}function Tt(){Xt=!1}var it=null;function me(t){if(qt&&d.observeMutations){var e=t.treeCallback,a=e===void 0?et:e,r=t.nodeCallback,n=r===void 0?et:r,o=t.pseudoElementsCallback,i=o===void 0?et:o,s=t.observeMutationsRoot,l=s===void 0?p:s;it=new qt(function(u){if(!Xt){var m=_();H(u).forEach(function(c){if(c.type==="childList"&&c.addedNodes.length>0&&!ce(c.addedNodes[0])&&(d.searchPseudoElements&&i(c.target),a(c.target)),c.type==="attributes"&&c.target.parentNode&&d.searchPseudoElements&&i([c.target],!0),c.type==="attributes"&&ce(c.target)&&~yn.indexOf(c.attributeName))if(c.attributeName==="class"&&ii(c.target)){var g=ft(zt(c.target)),h=g.prefix,y=g.iconName;c.target.setAttribute(Dt,h||m),y&&c.target.setAttribute(Lt,y)}else oi(c.target)&&n(c.target)})}}),j&&it.observe(l,{childList:!0,attributes:!0,characterData:!0,subtree:!0})}}function ci(){it&&it.disconnect()}function di(t){var e=t.getAttribute("style"),a=[];return e&&(a=e.split(";").reduce(function(r,n){var o=n.split(":"),i=o[0],s=o.slice(1);return i&&s.length>0&&(r[i]=s.join(":").trim()),r},{})),a}function mi(t){var e=t.getAttribute("data-prefix"),a=t.getAttribute("data-icon"),r=t.innerText!==void 0?t.innerText.trim():"",n=ft(zt(t));return n.prefix||(n.prefix=_()),e&&a&&(n.prefix=e,n.iconName=a),n.iconName&&n.prefix||(n.prefix&&r.length>0&&(n.iconName=Dn(n.prefix,t.innerText)||Yt(n.prefix,sa(t.innerText))),!n.iconName&&d.autoFetchSvg&&t.firstChild&&t.firstChild.nodeType===Node.TEXT_NODE&&(n.iconName=t.firstChild.data)),n}function vi(t){var e=H(t.attributes).reduce(function(a,r){return a.name!=="class"&&a.name!=="style"&&(a[r.name]=r.value),a},{});return e}function hi(){return{iconName:null,prefix:null,transform:F,symbol:!1,mask:{iconName:null,prefix:null,rest:[]},maskId:null,extra:{classes:[],styles:{},attributes:{}}}}function ve(t){var e=arguments.length>1&&arguments[1]!==void 0?arguments[1]:{styleParser:!0},a=mi(t),r=a.iconName,n=a.prefix,o=a.rest,i=vi(t),s=Ft("parseNodeAttributes",{},t),l=e.styleParser?di(t):[];return f({iconName:r,prefix:n,transform:F,mask:{iconName:null,prefix:null,rest:[]},maskId:null,symbol:!1,extra:{classes:o,styles:l,attributes:i}},s)}var gi=I.styles;function Aa(t){var e=d.autoReplaceSvg==="nest"?ve(t,{styleParser:!1}):ve(t);return~e.extra.classes.indexOf(ea)?$("generateLayersText",t,e):$("generateSvgReplacementMutation",t,e)}function pi(){return[].concat(E(Be),E(Ve))}function he(t){var e=arguments.length>1&&arguments[1]!==void 0?arguments[1]:null;if(!j)return Promise.resolve();var a=p.documentElement.classList,r=function(c){return a.add("".concat(te,"-").concat(c))},n=function(c){return a.remove("".concat(te,"-").concat(c))},o=d.autoFetchSvg?pi():Oe.concat(Object.keys(gi));o.includes("fa")||o.push("fa");var i=[".".concat(ea,":not([").concat(D,"])")].concat(o.map(function(m){return".".concat(m,":not([").concat(D,"])")})).join(", ");if(i.length===0)return Promise.resolve();var s=[];try{s=H(t.querySelectorAll(i))}catch{}if(s.length>0)r("pending"),n("complete");else return Promise.resolve();var l=Gt.begin("onTree"),u=s.reduce(function(m,c){try{var g=Aa(c);g&&m.push(g)}catch(h){Ze||h.name==="MissingIcon"&&console.error(h)}return m},[]);return new Promise(function(m,c){Promise.all(u).then(function(g){xa(g,function(){r("active"),r("complete"),n("pending"),typeof e=="function"&&e(),l(),m()})}).catch(function(g){l(),c(g)})})}function bi(t){var e=arguments.length>1&&arguments[1]!==void 0?arguments[1]:null;Aa(t).then(function(a){a&&xa([a],e)})}function yi(t){return function(e){var a=arguments.length>1&&arguments[1]!==void 0?arguments[1]:{},r=(e||{}).icon?e:Ot(e||{}),n=a.mask;return n&&(n=(n||{}).icon?n:Ot(n||{})),t(r,f(f({},a),{},{mask:n}))}}var xi=function(e){var a=arguments.length>1&&arguments[1]!==void 0?arguments[1]:{},r=a.transform,n=r===void 0?F:r,o=a.symbol,i=o===void 0?!1:o,s=a.mask,l=s===void 0?null:s,u=a.maskId,m=u===void 0?null:u,c=a.classes,g=c===void 0?[]:c,h=a.attributes,y=h===void 0?{}:h,b=a.styles,A=b===void 0?{}:b;if(e){var x=e.prefix,S=e.iconName,P=e.icon;return ut(f({type:"icon"},e),function(){return L("beforeDOMElementCreation",{iconDefinition:e,params:a}),Ht({icons:{main:Ct(P),mask:l?Ct(l.icon):{found:!1,width:null,height:null,icon:{}}},prefix:x,iconName:S,transform:f(f({},F),n),symbol:i,maskId:m,extra:{attributes:y,styles:A,classes:g}})})}},wi={mixout:function(){return{icon:yi(xi)}},hooks:function(){return{mutationObserverCallbacks:function(a){return a.treeCallback=he,a.nodeCallback=bi,a}}},provides:function(e){e.i2svg=function(a){var r=a.node,n=r===void 0?p:r,o=a.callback,i=o===void 0?function(){}:o;return he(n,i)},e.generateSvgReplacementMutation=function(a,r){var n=r.iconName,o=r.prefix,i=r.transform,s=r.symbol,l=r.mask,u=r.maskId,m=r.extra;return new Promise(function(c,g){Promise.all([Nt(n,o),l.iconName?Nt(l.iconName,l.prefix):Promise.resolve({found:!1,width:512,height:512,icon:{}})]).then(function(h){var y=ot(h,2),b=y[0],A=y[1];c([a,Ht({icons:{main:b,mask:A},prefix:o,iconName:n,transform:i,symbol:s,maskId:u,extra:m,watchable:!0})])}).catch(g)})},e.generateAbstractIcon=function(a){var r=a.children,n=a.attributes,o=a.main,i=a.transform,s=a.styles,l=st(s);l.length>0&&(n.style=l);var u;return Wt(i)&&(u=$("generateAbstractTransformGrouping",{main:o,transform:i,containerWidth:o.width,iconWidth:o.width})),r.push(u||o.icon),{children:r,attributes:n}}}},Ai={mixout:function(){return{layer:function(a){var r=arguments.length>1&&arguments[1]!==void 0?arguments[1]:{},n=r.classes,o=n===void 0?[]:n;return ut({type:"layer"},function(){L("beforeDOMElementCreation",{assembler:a,params:r});var i=[];return a(function(s){Array.isArray(s)?s.map(function(l){i=i.concat(l.abstract)}):i=i.concat(s.abstract)}),[{tag:"span",attributes:{class:["".concat(d.cssPrefix,"-layers")].concat(E(o)).join(" ")},children:i}]})}}}},Si={mixout:function(){return{counter:function(a){var r=arguments.length>1&&arguments[1]!==void 0?arguments[1]:{};r.title;var n=r.classes,o=n===void 0?[]:n,i=r.attributes,s=i===void 0?{}:i,l=r.styles,u=l===void 0?{}:l;return ut({type:"counter",content:a},function(){return L("beforeDOMElementCreation",{content:a,params:r}),ei({content:a.toString(),extra:{attributes:s,styles:u,classes:["".concat(d.cssPrefix,"-layers-counter")].concat(E(o))}})})}}}},ki={mixout:function(){return{text:function(a){var r=arguments.length>1&&arguments[1]!==void 0?arguments[1]:{},n=r.transform,o=n===void 0?F:n,i=r.classes,s=i===void 0?[]:i,l=r.attributes,u=l===void 0?{}:l,m=r.styles,c=m===void 0?{}:m;return ut({type:"text",content:a},function(){return L("beforeDOMElementCreation",{content:a,params:r}),fe({content:a,transform:f(f({},F),o),extra:{attributes:u,styles:c,classes:["".concat(d.cssPrefix,"-layers-text")].concat(E(s))}})})}}},provides:function(e){e.generateLayersText=function(a,r){var n=r.transform,o=r.extra,i=null,s=null;if(Ee){var l=parseInt(getComputedStyle(a).fontSize,10),u=a.getBoundingClientRect();i=u.width/l,s=u.height/l}return Promise.resolve([a,fe({content:a.innerHTML,width:i,height:s,transform:n,extra:o,watchable:!0})])}}},Sa=new RegExp('"',"ug"),ge=[1105920,1112319],pe=f(f(f(f({},{FontAwesome:{normal:"fas",400:"fas"}}),ir),cn),vr),_t=Object.keys(pe).reduce(function(t,e){return t[e.toLowerCase()]=pe[e],t},{}),Pi=Object.keys(_t).reduce(function(t,e){var a=_t[e];return t[e]=a[900]||E(Object.entries(a))[0][1],t},{});function Ii(t){var e=t.replace(Sa,"");return sa(E(e)[0]||"")}function Ei(t){var e=t.getPropertyValue("font-feature-settings").includes("ss01"),a=t.getPropertyValue("content"),r=a.replace(Sa,""),n=r.codePointAt(0),o=n>=ge[0]&&n<=ge[1],i=r.length===2?r[0]===r[1]:!1;return o||i||e}function Fi(t,e){var a=t.replace(/^['"]|['"]$/g,"").toLowerCase(),r=parseInt(e),n=isNaN(r)?"normal":r;return(_t[a]||{})[n]||Pi[a]}function be(t,e){var a="".concat(dn).concat(e.replace(":","-"));return new Promise(function(r,n){if(t.getAttribute(a)!==null)return r();var o=H(t.children),i=o.filter(function(ct){return ct.getAttribute(St)===e})[0],s=T.getComputedStyle(t,e),l=s.getPropertyValue("font-family"),u=l.match(pn),m=s.getPropertyValue("font-weight"),c=s.getPropertyValue("content");if(i&&!u)return t.removeChild(i),r();if(u&&c!=="none"&&c!==""){var g=s.getPropertyValue("content"),h=Fi(l,m),y=Ii(g),b=u[0].startsWith("FontAwesome"),A=Ei(s),x=Yt(h,y),S=x;if(b){var P=Ln(y);P.iconName&&P.prefix&&(x=P.iconName,h=P.prefix)}if(x&&!A&&(!i||i.getAttribute(Dt)!==h||i.getAttribute(Lt)!==S)){t.setAttribute(a,S),i&&t.removeChild(i);var R=hi(),O=R.extra;O.attributes[St]=e,Nt(x,h).then(function(ct){var ka=Ht(f(f({},R),{},{icons:{main:ct,mask:ga()},prefix:h,iconName:S,extra:O,watchable:!0})),dt=p.createElementNS("http://www.w3.org/2000/svg","svg");e==="::before"?t.insertBefore(dt,t.firstChild):t.appendChild(dt),dt.outerHTML=ka.map(function(Pa){return q(Pa)}).join(`
`),t.removeAttribute(a),r()}).catch(n)}else r()}else r()})}function Oi(t){return Promise.all([be(t,"::before"),be(t,"::after")])}function Ci(t){return t.parentNode!==document.head&&!~vn.indexOf(t.tagName.toUpperCase())&&!t.getAttribute(St)&&(!t.parentNode||t.parentNode.tagName!=="svg")}var Ni=function(e){return!!e&&Qe.some(function(a){return e.includes(a)})},ji=function(e){if(!e)return[];var a=new Set,r=e.split(/,(?![^()]*\))/).map(function(l){return l.trim()});r=r.flatMap(function(l){return l.includes("(")?l:l.split(",").map(function(u){return u.trim()})});var n=tt(r),o;try{for(n.s();!(o=n.n()).done;){var i=o.value;if(Ni(i)){var s=Qe.reduce(function(l,u){return l.replace(u,"")},i);s!==""&&s!=="*"&&a.add(s)}}}catch(l){n.e(l)}finally{n.f()}return a};function ye(t){var e=arguments.length>1&&arguments[1]!==void 0?arguments[1]:!1;if(j){var a;if(e)a=t;else if(d.searchPseudoElementsFullScan)a=t.querySelectorAll("*");else{var r=new Set,n=tt(document.styleSheets),o;try{for(n.s();!(o=n.n()).done;){var i=o.value;try{var s=tt(i.cssRules),l;try{for(s.s();!(l=s.n()).done;){var u=l.value,m=ji(u.selectorText),c=tt(m),g;try{for(c.s();!(g=c.n()).done;){var h=g.value;r.add(h)}}catch(b){c.e(b)}finally{c.f()}}}catch(b){s.e(b)}finally{s.f()}}catch(b){d.searchPseudoElementsWarnings&&console.warn("Font Awesome: cannot parse stylesheet: ".concat(i.href," (").concat(b.message,`)
If it declares any Font Awesome CSS pseudo-elements, they will not be rendered as SVG icons. Add crossorigin="anonymous" to the <link>, enable searchPseudoElementsFullScan for slower but more thorough DOM parsing, or suppress this warning by setting searchPseudoElementsWarnings to false.`))}}}catch(b){n.e(b)}finally{n.f()}if(!r.size)return;var y=Array.from(r).join(", ");try{a=t.querySelectorAll(y)}catch{}}return new Promise(function(b,A){var x=H(a).filter(Ci).map(Oi),S=Gt.begin("searchPseudoElements");wa(),Promise.all(x).then(function(){S(),Tt(),b()}).catch(function(){S(),Tt(),A()})})}}var Ti={hooks:function(){return{mutationObserverCallbacks:function(a){return a.pseudoElementsCallback=ye,a}}},provides:function(e){e.pseudoElements2svg=function(a){var r=a.node,n=r===void 0?p:r;d.searchPseudoElements&&ye(n)}}},xe=!1,_i={mixout:function(){return{dom:{unwatch:function(){wa(),xe=!0}}}},hooks:function(){return{bootstrap:function(){me(Ft("mutationObserverCallbacks",{}))},noAuto:function(){ci()},watch:function(a){var r=a.observeMutationsRoot;xe?Tt():me(Ft("mutationObserverCallbacks",{observeMutationsRoot:r}))}}}},we=function(e){var a={size:16,x:0,y:0,flipX:!1,flipY:!1,rotate:0};return e.toLowerCase().split(" ").reduce(function(r,n){var o=n.toLowerCase().split("-"),i=o[0],s=o.slice(1).join("-");if(i&&s==="h")return r.flipX=!0,r;if(i&&s==="v")return r.flipY=!0,r;if(s=parseFloat(s),isNaN(s))return r;switch(i){case"grow":r.size=r.size+s;break;case"shrink":r.size=r.size-s;break;case"left":r.x=r.x-s;break;case"right":r.x=r.x+s;break;case"up":r.y=r.y-s;break;case"down":r.y=r.y+s;break;case"rotate":r.rotate=r.rotate+s;break}return r},a)},$i={mixout:function(){return{parse:{transform:function(a){return we(a)}}}},hooks:function(){return{parseNodeAttributes:function(a,r){var n=r.getAttribute("data-fa-transform");return n&&(a.transform=we(n)),a}}},provides:function(e){e.generateAbstractTransformGrouping=function(a){var r=a.main,n=a.transform,o=a.containerWidth,i=a.iconWidth,s={transform:"translate(".concat(o/2," 256)")},l="translate(".concat(n.x*32,", ").concat(n.y*32,") "),u="scale(".concat(n.size/16*(n.flipX?-1:1),", ").concat(n.size/16*(n.flipY?-1:1),") "),m="rotate(".concat(n.rotate," 0 0)"),c={transform:"".concat(l," ").concat(u," ").concat(m)},g={transform:"translate(".concat(i/2*-1," -256)")},h={outer:s,inner:c,path:g};return{tag:"g",attributes:f({},h.outer),children:[{tag:"g",attributes:f({},h.inner),children:[{tag:r.icon.tag,children:r.icon.children,attributes:f(f({},r.icon.attributes),h.path)}]}]}}}},yt={x:0,y:0,width:"100%",height:"100%"};function Ae(t){var e=arguments.length>1&&arguments[1]!==void 0?arguments[1]:!0;return t.attributes&&(t.attributes.fill||e)&&(t.attributes.fill="black"),t}function Mi(t){return t.tag==="g"?t.children:[t]}var Di={hooks:function(){return{parseNodeAttributes:function(a,r){var n=r.getAttribute("data-fa-mask"),o=n?ft(n.split(" ").map(function(i){return i.trim()})):ga();return o.prefix||(o.prefix=_()),a.mask=o,a.maskId=r.getAttribute("data-fa-mask-id"),a}}},provides:function(e){e.generateAbstractMask=function(a){var r=a.children,n=a.attributes,o=a.main,i=a.mask,s=a.maskId,l=a.transform,u=o.width,m=o.icon,c=i.width,g=i.icon,h=Fn({transform:l,containerWidth:c,iconWidth:u}),y={tag:"rect",attributes:f(f({},yt),{},{fill:"white"})},b=m.children?{children:m.children.map(Ae)}:{},A={tag:"g",attributes:f({},h.inner),children:[Ae(f({tag:m.tag,attributes:f(f({},m.attributes),h.path)},b))]},x={tag:"g",attributes:f({},h.outer),children:[A]},S="mask-".concat(s||ae()),P="clip-".concat(s||ae()),R={tag:"mask",attributes:f(f({},yt),{},{id:S,maskUnits:"userSpaceOnUse",maskContentUnits:"userSpaceOnUse"}),children:[y,x]},O={tag:"defs",children:[{tag:"clipPath",attributes:{id:P},children:Mi(g)},R]};return r.push(O,{tag:"rect",attributes:f({fill:"currentColor","clip-path":"url(#".concat(P,")"),mask:"url(#".concat(S,")")},yt)}),{children:r,attributes:n}}}},Li={provides:function(e){var a=!1;T.matchMedia&&(a=T.matchMedia("(prefers-reduced-motion: reduce)").matches),e.missingIconAbstract=function(){var r=[],n={fill:"currentColor"},o={attributeType:"XML",repeatCount:"indefinite",dur:"2s"};r.push({tag:"path",attributes:f(f({},n),{},{d:"M156.5,447.7l-12.6,29.5c-18.7-9.5-35.9-21.2-51.5-34.9l22.7-22.7C127.6,430.5,141.5,440,156.5,447.7z M40.6,272H8.5 c1.4,21.2,5.4,41.7,11.7,61.1L50,321.2C45.1,305.5,41.8,289,40.6,272z M40.6,240c1.4-18.8,5.2-37,11.1-54.1l-29.5-12.6 C14.7,194.3,10,216.7,8.5,240H40.6z M64.3,156.5c7.8-14.9,17.2-28.8,28.1-41.5L69.7,92.3c-13.7,15.6-25.5,32.8-34.9,51.5 L64.3,156.5z M397,419.6c-13.9,12-29.4,22.3-46.1,30.4l11.9,29.8c20.7-9.9,39.8-22.6,56.9-37.6L397,419.6z M115,92.4 c13.9-12,29.4-22.3,46.1-30.4l-11.9-29.8c-20.7,9.9-39.8,22.6-56.8,37.6L115,92.4z M447.7,355.5c-7.8,14.9-17.2,28.8-28.1,41.5 l22.7,22.7c13.7-15.6,25.5-32.9,34.9-51.5L447.7,355.5z M471.4,272c-1.4,18.8-5.2,37-11.1,54.1l29.5,12.6 c7.5-21.1,12.2-43.5,13.6-66.8H471.4z M321.2,462c-15.7,5-32.2,8.2-49.2,9.4v32.1c21.2-1.4,41.7-5.4,61.1-11.7L321.2,462z M240,471.4c-18.8-1.4-37-5.2-54.1-11.1l-12.6,29.5c21.1,7.5,43.5,12.2,66.8,13.6V471.4z M462,190.8c5,15.7,8.2,32.2,9.4,49.2h32.1 c-1.4-21.2-5.4-41.7-11.7-61.1L462,190.8z M92.4,397c-12-13.9-22.3-29.4-30.4-46.1l-29.8,11.9c9.9,20.7,22.6,39.8,37.6,56.9 L92.4,397z M272,40.6c18.8,1.4,36.9,5.2,54.1,11.1l12.6-29.5C317.7,14.7,295.3,10,272,8.5V40.6z M190.8,50 c15.7-5,32.2-8.2,49.2-9.4V8.5c-21.2,1.4-41.7,5.4-61.1,11.7L190.8,50z M442.3,92.3L419.6,115c12,13.9,22.3,29.4,30.5,46.1 l29.8-11.9C470,128.5,457.3,109.4,442.3,92.3z M397,92.4l22.7-22.7c-15.6-13.7-32.8-25.5-51.5-34.9l-12.6,29.5 C370.4,72.1,384.4,81.5,397,92.4z"})});var i=f(f({},o),{},{attributeName:"opacity"}),s={tag:"circle",attributes:f(f({},n),{},{cx:"256",cy:"364",r:"28"}),children:[]};return a||s.children.push({tag:"animate",attributes:f(f({},o),{},{attributeName:"r",values:"28;14;28;28;14;28;"})},{tag:"animate",attributes:f(f({},i),{},{values:"1;0;1;1;0;1;"})}),r.push(s),r.push({tag:"path",attributes:f(f({},n),{},{opacity:"1",d:"M263.7,312h-16c-6.6,0-12-5.4-12-12c0-71,77.4-63.9,77.4-107.8c0-20-17.8-40.2-57.4-40.2c-29.1,0-44.3,9.6-59.2,28.7 c-3.9,5-11.1,6-16.2,2.4l-13.1-9.2c-5.6-3.9-6.9-11.8-2.6-17.2c21.2-27.2,46.4-44.7,91.2-44.7c52.3,0,97.4,29.8,97.4,80.2 c0,67.6-77.4,63.5-77.4,107.8C275.7,306.6,270.3,312,263.7,312z"}),children:a?[]:[{tag:"animate",attributes:f(f({},i),{},{values:"1;0;0;0;0;1;"})}]}),a||r.push({tag:"path",attributes:f(f({},n),{},{opacity:"0",d:"M232.5,134.5l7,168c0.3,6.4,5.6,11.5,12,11.5h9c6.4,0,11.7-5.1,12-11.5l7-168c0.3-6.8-5.2-12.5-12-12.5h-23 C237.7,122,232.2,127.7,232.5,134.5z"}),children:[{tag:"animate",attributes:f(f({},i),{},{values:"0;0;1;1;0;0;"})}]}),{tag:"g",attributes:{class:"missing"},children:r}}}},Ri={hooks:function(){return{parseNodeAttributes:function(a,r){var n=r.getAttribute("data-fa-symbol"),o=n===null?!1:n===""?!0:n;return a.symbol=o,a}}}},zi=[Nn,wi,Ai,Si,ki,Ti,_i,$i,Di,Li,Ri];Bn(zi,{mixoutsTo:k});k.noAuto;var Wi=k.config;k.library;k.dom;var Ui=k.parse;k.findIconDefinition;k.toHtml;var Yi=k.icon;k.layer;k.text;k.counter;export{Wi as c,Yi as i,Ui as p};
//# sourceMappingURL=fa-core-Bt2frMsK.js.map
