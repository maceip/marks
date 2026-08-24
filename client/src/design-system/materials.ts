export type MaterialRecipeName = 'chrome' | 'panel' | 'floating' | 'hero' | 'opaqueDocument';
export type MaterialModifier = 'subtle' | 'standard' | 'emphasized';

export interface MaterialRecipe {
  tint: string;
  border: string;
  highlight: string;
  shadow: string;
  blur: string;
  saturation: string;
  shaderOpacity: string;
  shaderIntensity: number;
  motionResponse: string;
  fallbackBackground: string;
}

/** The single vocabulary for rendered surfaces. Document bodies are deliberately opaque. */
export const MATERIAL_RECIPES: Readonly<Record<MaterialRecipeName, Readonly<MaterialRecipe>>> = {
  chrome: { tint: 'var(--material-tint)', border: 'var(--material-border)', highlight: 'var(--material-highlight)', shadow: 'var(--material-elevation)', blur: 'var(--material-blur-chrome)', saturation: 'var(--material-saturation)', shaderOpacity: '.70', shaderIntensity: .96, motionResponse: '.72', fallbackBackground: 'var(--color-bg-raised)' },
  panel: { tint: 'var(--material-tint)', border: 'var(--material-border)', highlight: 'var(--material-highlight)', shadow: 'var(--material-elevation)', blur: 'var(--material-blur-panel)', saturation: 'var(--material-saturation)', shaderOpacity: '.82', shaderIntensity: .88, motionResponse: '.58', fallbackBackground: 'var(--color-bg-raised)' },
  floating: { tint: 'var(--material-tint)', border: 'var(--material-border)', highlight: 'var(--material-highlight)', shadow: 'var(--elevation-lg)', blur: 'var(--material-blur-floating)', saturation: 'var(--material-saturation)', shaderOpacity: '.96', shaderIntensity: 1.08, motionResponse: '1', fallbackBackground: 'var(--color-bg-raised)' },
  hero: { tint: 'var(--material-tint)', border: 'var(--material-border)', highlight: 'var(--material-highlight)', shadow: 'var(--material-elevation)', blur: 'var(--material-blur-panel)', saturation: 'var(--material-saturation)', shaderOpacity: '.76', shaderIntensity: .92, motionResponse: '.84', fallbackBackground: 'var(--color-bg-raised)' },
  opaqueDocument: { tint: 'var(--color-bg-raised)', border: 'var(--color-border-default)', highlight: 'transparent', shadow: 'var(--elevation-sm)', blur: '0px', saturation: '100%', shaderOpacity: '0', shaderIntensity: 0, motionResponse: '0', fallbackBackground: 'var(--color-bg-raised)' },
};

const MODIFIER_SCALE: Record<MaterialModifier, number> = { subtle: .86, standard: 1, emphasized: 1.12 };

export function materialVariables(name: MaterialRecipeName, modifier: MaterialModifier = 'standard'): Record<string, string> {
  const recipe = MATERIAL_RECIPES[name];
  return {
    '--material-tint': recipe.tint, '--material-border': recipe.border,
    '--material-highlight': recipe.highlight, '--material-shadow': recipe.shadow,
    '--material-blur': recipe.blur, '--material-saturation': recipe.saturation,
    '--material-shader-opacity': recipe.shaderOpacity,
    '--material-shader-intensity': String(recipe.shaderIntensity * MODIFIER_SCALE[modifier]),
    '--material-motion-response': recipe.motionResponse,
    '--material-fallback-background': recipe.fallbackBackground,
  };
}
