export function step(array) {
    const next = Array.prototype.pop.call(array);

    Array.prototype.unshift.call(array, next);

    return next;
}


const invLog2 = 1/Math.log(2);

export const nextPow2 = (x) => Math.pow(2, Math.ceil(Math.log(x)*invLog2));