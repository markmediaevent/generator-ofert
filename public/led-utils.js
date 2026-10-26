(function(root){
  'use strict';
  const MODELS = Object.freeze({
    'yes-tech-p39': { id:'yes-tech-p39', label:'Yes Tech P3.9', width:0.5, height:0.5 },
    'gloshine-p4': { id:'gloshine-p4', label:'Gloshine P4 / P4.8', width:0.5, height:0.5 },
    'dicolor-p4': { id:'dicolor-p4', label:'Dicolor P4', width:0.5, height:1.0 }
  });
  function numeric(value){
    if(typeof value==='string')value=value.replace(',','.');
    const n=Number(value);
    return Number.isFinite(n)?n:NaN;
  }
  function inferModel(item){
    const explicit=String(item?.ledModel||'');
    if(MODELS[explicit])return explicit;
    const name=String(item?.name||'').toLowerCase();
    if(/dicolor/.test(name))return 'dicolor-p4';
    if(/gloshine/.test(name))return 'gloshine-p4';
    if(/yes[\s-]*tech/.test(name))return 'yes-tech-p39';
    if(/\bp3[.,]9\b/.test(name))return 'yes-tech-p39';
    return '';
  }
  function dimensionsFromItem(item){
    const width=numeric(item?.ledScreenWidth);
    const height=numeric(item?.ledScreenHeight);
    if(width>0&&height>0)return {width,height};
    // Oferty sprzed wcześniejszej aktualizacji zapisywały wymiary tylko w opisie.
    const text=String(item?.desc||'');
    const match=text.match(/(\d+(?:[.,]\d+)?)\s*m\s*[×xX]\s*(\d+(?:[.,]\d+)?)\s*m/i);
    if(match)return {width:numeric(match[1]),height:numeric(match[2])};
    return {width:0,height:0};
  }
  function initialConfig(item){
    const dims=dimensionsFromItem(item);
    return {
      model: inferModel(item),
      width:dims.width,
      height:dims.height,
      orientation: item?.ledOrientation==='horizontal'?'horizontal':'vertical'
    };
  }
  function isScreen(item){
    return item?.source==='led-calc' || (item?.category==='led' && /^\s*ekran(?:y)?\s*led\b/i.test(String(item?.name||'')));
  }
  function calculate(config){
    const model=MODELS[String(config?.model||'')];
    const width=numeric(config?.width),height=numeric(config?.height);
    if(!model || !Number.isFinite(width) || !Number.isFinite(height) || width<=0 || height<=0 || width>500 || height>500)return null;
    const horizontal=config.orientation==='horizontal';
    const cabWidth=horizontal?model.height:model.width;
    const cabHeight=horizontal?model.width:model.height;
    const columns=Math.ceil(width/cabWidth-1e-9);
    const rows=Math.ceil(height/cabHeight-1e-9);
    const total=columns*rows;
    const builtWidth=Number((columns*cabWidth).toFixed(4));
    const builtHeight=Number((rows*cabHeight).toFixed(4));
    const exact=Math.abs(builtWidth-width)<1e-6 && Math.abs(builtHeight-height)<1e-6;
    return {model:model.id,modelLabel:model.label,columns,rows,total,cabWidth,cabHeight,builtWidth,builtHeight,
      requestedWidth:width,requestedHeight:height,exact};
  }
  // Założenia planistyczne, nie parametry fabryczne. Edytowane per ekran na pack liście.
  const LOGISTICS_DEFAULTS=Object.freeze({caseSize:8,dataChainSize:10,powerChainSize:8,spares:0,pixelWidth:0,pixelHeight:0,portCapacity:650000,portCount:4,backup:false,portCabinets:''});
  function logistics(calculation,settings={}){
    if(!calculation)return null;
    const cfg={...LOGISTICS_DEFAULTS,...settings};
    const whole=(key,min,max)=>{
      const n=Number(cfg[key]);
      return Number.isInteger(n)&&n>=min&&n<=max?n:LOGISTICS_DEFAULTS[key];
    };
    const caseSize=whole('caseSize',1,50);
    const dataChainSize=whole('dataChainSize',1,100);
    const powerChainSize=whole('powerChainSize',1,100);
    const spares=whole('spares',0,1000);
    const count=calculation.total;
    const signal=signalPlan(calculation,cfg);
    const dataRuns=signal.ready&&signal.valid?signal.ports.length:Math.ceil(count/dataChainSize);
    const powerRuns=Math.ceil(count/powerChainSize);
    return {
      signal,backupFeeds:signal.ready&&signal.valid&&cfg.backup?dataRuns:0,count,spares,totalCabinets:count+spares,caseSize,dataChainSize,powerChainSize,
      cases:Math.ceil((count+spares)/caseSize),
      dataRuns, dataJumpers:Math.max(0,count-dataRuns),
      powerRuns, powerJumpers:Math.max(0,count-powerRuns),
      assumptions:'Wartości orientacyjne. Zweryfikuj obciążenie, topologię i limity producenta.'
    };
  }
  function signalPlan(calculation,cfg={}){
    if(!calculation)return null;
    const w=Number(cfg.pixelWidth),h=Number(cfg.pixelHeight),capacity=Number(cfg.portCapacity),available=Number(cfg.portCount);
    if(!w||!h)return {ready:false,valid:false,ports:[],message:'Podaj rozdzielczość kabinetu w pikselach, aby policzyć porty DATA.'};
    if(![w,h,capacity,available].every(Number.isInteger)||w<1||h<1||capacity<1||available<1||available>128)return {ready:true,valid:false,ports:[],message:'Niepoprawne parametry portów.'};
    const pixels=w*h,perPort=Math.floor(capacity/pixels);
    if(perPort<1)return {ready:true,valid:false,ports:[],message:'Jeden kabinet przekracza limit portu.'};
    let counts=[];
    if(String(cfg.portCabinets||'').trim()){
      counts=String(cfg.portCabinets).split(/[,;\s]+/).filter(Boolean).map(Number);
      if(counts.length>1000||counts.some(n=>!Number.isInteger(n)||n<1)||counts.reduce((a,b)=>a+b,0)!==calculation.total)return {ready:true,valid:false,ports:[],message:'Suma kabinetów na portach musi odpowiadać liczbie kabinetów ekranu.'};
    }else{
      if(Math.ceil(calculation.total/perPort)>1000)return {ready:true,valid:false,ports:[],message:'Plan przekracza 1000 portów. Sprawdź parametry.'};
      for(let left=calculation.total;left>0;left-=perPort)counts.push(Math.min(left,perPort));
    }
    const ports=counts.map((count,index)=>({port:index+1,count,pixels:count*pixels,load:count*pixels/capacity*100,overloaded:count*pixels>capacity}));
    const required=ports.length*(cfg.backup?2:1),overloaded=ports.some(p=>p.overloaded);
    return {ready:true,valid:true,ports,capacity,available,required,primaryFeeds:ports.length,backupFeeds:cfg.backup?ports.length:0,overloaded,insufficient:required>available,
      message:overloaded?'PRZECIĄŻENIE PORTU':required>available?'ZA MAŁO PORTÓW DLA WYBRANEGO BACKUPU':''};
  }
  root.MM_LED={signalPlan,MODELS,numeric,inferModel,dimensionsFromItem,initialConfig,isScreen,calculate,LOGISTICS_DEFAULTS,logistics};
})(typeof window!=='undefined'?window:globalThis);
