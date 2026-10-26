import unittest
import demo
class PolicyTests(unittest.TestCase):
    def test_allow(self):
        self.assertTrue(demo.policy(demo.parse_intent('Deploy nginx with two replicas to demo'))[0])
    def test_deny_prod(self):
        self.assertEqual(demo.policy(demo.parse_intent('Deploy nginx with two replicas to production'))[1], 'TARGET_NOT_ALLOWED')
    def test_deny_unsafe(self):
        self.assertFalse(demo.policy({'operation':'deploy','workload':'nginx','replicas':2,'target':'demo','command':'kubectl apply'})[0])
    def test_digest_stable(self):
        self.assertEqual(demo.digest({'a':1,'b':2}), demo.digest({'b':2,'a':1}))
    def test_deny_1_replica(self):
        self.assertFalse(demo.policy(demo.parse_intent('Deploy nginx with one replica'))[0])
if __name__ == '__main__': unittest.main()
