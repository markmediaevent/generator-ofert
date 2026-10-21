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
  root.MM_LED={MODELS,numeric,inferModel,dimensionsFromItem,initialConfig,isScreen,calculate};
})(typeof window!=='undefined'?window:globalThis);
