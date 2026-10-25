/**
 * How the user should type the next command: `npx accessibility-check …` when
 * they ran it through npx (the bin is not on their PATH), else the bin name.
 */
module.exports = function cliName() {
  const viaNpx = process.env.npm_command === 'exec' || /[\\/]_npx[\\/]/.test(process.argv[1] || '');
  return viaNpx ? 'npx accessibility-check' : 'accessibility-check';
};
