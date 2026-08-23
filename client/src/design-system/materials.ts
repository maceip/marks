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
  chrome: { tint: 'var(--glass)', border: 'var(--glass-border)', highlight: 'var(--glass-highlight)', shadow: 'var(--glass-shadow)', blur: 'var(--glass-blur-chrome)', saturation: 'var(--glass-saturation)', shaderOpacity: '.70', shaderIntensity: .96, motionResponse: '.72', fallbackBackground: 'var(--surface-raised)' },
  panel: { tint: 'var(--glass)', border: 'var(--glass-border)', highlight: 'var(--glass-highlight)', shadow: 'var(--glass-shadow)', blur: 'var(--glass-blur-panel)', saturation: 'var(--glass-saturation)', shaderOpacity: '.82', shaderIntensity: .88, motionResponse: '.58', fallbackBackground: 'var(--surface-raised)' },
  floating: { tint: 'var(--glass)', border: 'var(--glass-border)', highlight: 'var(--glass-highlight)', shadow: 'var(--shadow-lg)', blur: 'var(--glass-blur-floating)', saturation: 'var(--glass-saturation)', shaderOpacity: '.96', shaderIntensity: 1.08, motionResponse: '1', fallbackBackground: 'var(--surface-raised)' },
  hero: { tint: 'var(--glass)', border: 'var(--glass-border)', highlight: 'var(--glass-highlight)', shadow: 'var(--glass-shadow)', blur: 'var(--glass-blur-panel)', saturation: 'var(--glass-saturation)', shaderOpacity: '.76', shaderIntensity: .92, motionResponse: '.84', fallbackBackground: 'var(--surface-raised)' },
  opaqueDocument: { tint: 'var(--surface-raised)', border: 'var(--border)', highlight: 'transparent', shadow: 'var(--shadow-sm)', blur: '0px', saturation: '100%', shaderOpacity: '0', shaderIntensity: 0, motionResponse: '0', fallbackBackground: 'var(--surface-raised)' },
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
