export type RoleBadgeStyle = 'default' | 'fill' | 'outline'

export const PRESET_ROLE_COLORS: Array<{ hex: string; label: string }> = [
  { hex: '#1abc9c', label: 'Teal' },
  { hex: '#2ecc71', label: 'Green' },
  { hex: '#3498db', label: 'Blue' },
  { hex: '#9b59b6', label: 'Purple' },
  { hex: '#e91e63', label: 'Pink' },
  { hex: '#f1c40f', label: 'Yellow' },
  { hex: '#e67e22', label: 'Orange' },
  { hex: '#e74c3c', label: 'Red' },
  { hex: '#95a5a6', label: 'Gray' },
  { hex: '#607d8b', label: 'Blue Gray' },
  { hex: '#11806a', label: 'Dark Teal' },
  { hex: '#1f8b4c', label: 'Dark Green' },
  { hex: '#206694', label: 'Dark Blue' },
  { hex: '#71368a', label: 'Dark Purple' },
  { hex: '#ad1457', label: 'Dark Pink' },
  { hex: '#c27c0e', label: 'Dark Yellow' },
  { hex: '#a84300', label: 'Dark Orange' },
  { hex: '#992d22', label: 'Dark Red' },
  { hex: '#979c9f', label: 'Dark Gray' },
  { hex: '#546e7a', label: 'Dark Blue Gray' },
]

export const ROLE_BADGE_STYLE_OPTIONS: Array<{
  value: RoleBadgeStyle
  label: string
  description: string
}> = [
  {
    value: 'default',
    label: 'Default',
    description: 'Soft background with a subtle border.',
  },
  {
    value: 'fill',
    label: 'Fill',
    description: 'Solid color badge with strong contrast.',
  },
  {
    value: 'outline',
    label: 'Outline',
    description: 'Border-only style with no background.',
  },
]
